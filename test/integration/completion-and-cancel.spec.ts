import { sql } from 'drizzle-orm';
import { AppConfig } from '../../src/shared/config/app-config';
import { Canceller } from '../../src/worker/cancellation/canceller';
import { CancellationRepository } from '../../src/worker/cancellation/cancellation.repository';
import { WorkerMetrics } from '../../src/worker/metrics/worker-metrics';
import { DeliveryRepository } from '../../src/worker/dispatch/delivery.repository';
import {
  alarmStatus,
  CapturingLogger,
  deliveryStatuses,
  insertAlarm,
  testConfig,
} from './support/fixtures';
import { createTestDatabase, TestDatabase } from './support/test-database';

const neverFatal = (reason: string): never => {
  throw new Error(reason);
};

describe('완료 판정: 마지막 기록이 같은 트랜잭션에서 판정한다 (ADR-0018)', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database.drop();
  });

  it('마지막 두 건을 두 워커가 동시에 기록해도 알림은 정확히 COMPLETED가 된다', async () => {
    for (let round = 0; round < 15; round++) {
      const alarm = await insertAlarm(database.db, {
        type: 'URGENT',
        recipients: ['u_1', 'u_2'],
      });
      const first = new DeliveryRepository(database.db, 101);
      const second = new DeliveryRepository(database.db, 102);
      const [a] = await first.claim(1);
      const [b] = await second.claim(1);
      const [ra, rb] = await Promise.all([
        first.recordSend(a, { kind: 'sent', messageId: 'm_a' }, 100),
        second.recordSend(b, { kind: 'sent', messageId: 'm_b' }, 100),
      ]);

      expect(await alarmStatus(database.db, alarm.id)).toBe('COMPLETED');
      // 둘 중 정확히 한쪽만 알림을 끝냈다.
      expect(
        [ra, rb].filter((r) => r.applied && r.finished === 'COMPLETED'),
      ).toHaveLength(1);
    }
  });

  it('펼치기가 끝나지 않았으면 남은 건이 없어도 완료하지 않는다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['u_1'],
      expansionDone: false,
    });
    const store = new DeliveryRepository(database.db, 1);
    const [delivery] = await store.claim(1);

    await store.recordSend(delivery, { kind: 'sent', messageId: 'm' }, 100);
    expect(await alarmStatus(database.db, alarm.id)).toBe('SENDING');
  });

  it('넘겨받힌 뒤 늦게 도착한 기록은 펜싱에 걸려 반영되지 않는다 (ADR-0004)', async () => {
    await insertAlarm(database.db, { type: 'URGENT', recipients: ['u_1'] });
    const stale = new DeliveryRepository(database.db, 7);
    const [delivery] = await stale.claim(1);

    // 다른 워커가 넘겨받아 owner와 시도 번호가 바뀐 상황
    await database.db.execute(
      sql`UPDATE deliveries SET owner = 8, attempts = attempts + 1 WHERE id = ${delivery.id}`,
    );
    const outcome = await stale.recordSend(
      delivery,
      { kind: 'failed', code: 'X', message: 'x' },
      100,
    );

    expect(outcome.applied).toBe(false);
    const row = await database.db.execute<{ status: string; owner: number }>(
      sql`SELECT status, owner FROM deliveries WHERE id = ${delivery.id}`,
    );

    expect(row.rows[0]).toEqual({ status: 'IN_FLIGHT', owner: 8 });
  });

  it('429는 시도 횟수를 되돌리고 바로 대기로 돌린다 (ADR-0014)', async () => {
    await insertAlarm(database.db, { type: 'URGENT', recipients: ['u_1'] });
    const store = new DeliveryRepository(database.db, 1);
    const [delivery] = await store.claim(1);

    await store.recordSend(
      delivery,
      { kind: 'requeue_uncounted', code: 'RATE_LIMITED', message: 'x' },
      100,
    );
    const row = await database.db.execute<{ status: string; attempts: number }>(
      sql`SELECT status, attempts FROM deliveries WHERE id = ${delivery.id}`,
    );

    expect(row.rows[0]).toEqual({ status: 'PENDING', attempts: 0 });
  });
});

describe('취소 (ADR-0017)', () => {
  let database: TestDatabase;
  let config: AppConfig;

  beforeEach(async () => {
    database = await createTestDatabase();
    config = testConfig(database.url, 'http://127.0.0.1:9');
  });
  afterEach(async () => {
    await database.drop();
  });

  async function runCleanup(workerId: number): Promise<void> {
    const canceller = new Canceller(
      config,
      database.db,
      new CancellationRepository(database.db, workerId),
      workerId,
      new WorkerMetrics(),
      new CapturingLogger(),
      neverFatal,
    );

    canceller.start();
    await new Promise((r) => setTimeout(r, 300));
    await canceller.stop();
  }

  it('정리는 대기 건만 CANCELED로 바꾸고, 보내는 중인 건이 끝나면 알림이 CANCELED가 된다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['p1', 'p2', 'f1'],
    });
    const store = new DeliveryRepository(database.db, 1);
    const inFlight = (await store.claim(10)).filter(
      (d) => d.recipientId === 'f1',
    )[0];

    await database.db.execute(
      sql`UPDATE deliveries SET status = 'PENDING', owner = NULL WHERE recipient_id IN ('p1', 'p2')`,
    );
    await database.db.execute(
      sql`UPDATE alarms SET status = 'CANCELING' WHERE id = ${alarm.id}`,
    );

    await runCleanup(2);
    expect(await deliveryStatuses(database.db, alarm.id)).toEqual({
      p1: 'CANCELED',
      p2: 'CANCELED',
      f1: 'IN_FLIGHT',
    });
    expect(await alarmStatus(database.db, alarm.id)).toBe('CANCELING');

    // 이미 나간 건은 그대로 결과를 기록한다. 이 기록이 마지막이라 알림이 끝난다.
    const outcome = await store.recordSend(
      inFlight,
      { kind: 'sent', messageId: 'm' },
      100,
    );

    expect(outcome).toEqual({ applied: true, finished: 'CANCELED' });
    expect((await deliveryStatuses(database.db, alarm.id)).f1).toBe('SENT');
  });

  it('정리가 끝난 뒤 보내던 건이 재시도로 돌아오면 대기가 아니라 CANCELED가 된다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['f1'],
    });
    const store = new DeliveryRepository(database.db, 1);
    const [delivery] = await store.claim(1);

    await database.db.execute(
      sql`UPDATE alarms SET status = 'CANCELING' WHERE id = ${alarm.id}`,
    );
    await runCleanup(2);

    const outcome = await store.recordSend(
      delivery,
      { kind: 'retry', delayMs: 10, code: 'SERVICE_UNAVAILABLE', message: 'x' },
      100,
    );

    expect(outcome).toEqual({ applied: true, finished: 'CANCELED' });
    expect(await deliveryStatuses(database.db, alarm.id)).toEqual({
      f1: 'CANCELED',
    });
  });

  it('결과 미확정 건은 조회해서 기록이 없으면 다시 보내지 않고 CANCELED가 된다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['q1'],
    });

    await database.db.execute(sql`
      UPDATE deliveries SET status = 'UNCONFIRMED', attempts = 1, reconcile_after = clock_timestamp() WHERE alarm_id = ${alarm.id}`);
    await database.db.execute(
      sql`UPDATE alarms SET status = 'CANCELING' WHERE id = ${alarm.id}`,
    );
    const store = new DeliveryRepository(database.db, 3);
    const [item] = await store.claimReconcile(10, 1000);
    const { decision, outcome } = await store.recordReconcile(
      item,
      (canceling) => (canceling ? { kind: 'canceled' } : { kind: 'resend' }),
    );

    expect(decision).toEqual({ kind: 'canceled' });
    expect(outcome).toEqual({ applied: true, finished: 'CANCELED' });
  });
});
