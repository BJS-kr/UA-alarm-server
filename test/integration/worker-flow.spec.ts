import { sql } from 'drizzle-orm';
import { clientRefOf } from '../../src/shared/domain/status';
import { sleep } from '../../src/worker/runtime/loop-utils';
import { FakeExternalApi } from './support/fake-external-api';
import {
  alarmStatus,
  deliveryStatuses,
  insertAlarm,
  RunningWorker,
  startWorker,
  testConfig,
  userIds,
  waitFor,
} from './support/fixtures';
import { createTestDatabase, TestDatabase } from './support/test-database';

describe('워커 전체 흐름 (ADR-0002, 0006, 0009, 0011, 0014)', () => {
  let database: TestDatabase;
  let fake: FakeExternalApi;
  let fakeUrl: string;
  let workers: RunningWorker[];

  beforeEach(async () => {
    database = await createTestDatabase();
    fake = new FakeExternalApi();
    fakeUrl = await fake.start();
    workers = [];
  });

  afterEach(async () => {
    await Promise.all(
      workers.map((w) => w.runtime.stop().catch(() => undefined)),
    );
    await fake.stop();
    await database.drop();
  });

  const start = async (overrides: Record<string, string> = {}, count = 1) => {
    for (let i = 0; i < count; i++) {
      workers.push(
        await startWorker(testConfig(database.url, fakeUrl, overrides)),
      );
    }
  };

  it('장애를 섞어도 수신자마다 외부 기록이 정확히 한 번이다', async () => {
    const users = userIds(200);

    fake.users = users;
    const blocked = new Set(['u_000005', 'u_000006']);

    fake.behavior = (recipientId, attempt) => {
      const n = Number(recipientId.slice(2));
      if (blocked.has(recipientId)) return { type: 'reject' };

      if (attempt === 1 && n % 25 === 0) {
        return { type: 'record_then_hang', hangMs: 1500 };
      } // 접수는 됐는데 응답이 늦다

      if (attempt === 1 && n % 10 === 0) return { type: 'error', status: 503 };
      if (attempt === 1 && n % 40 === 1) return { type: 'rate_limit' };

      return { type: 'accept' };
    };

    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({}, 2);

    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      30_000,
    );

    const statuses = await deliveryStatuses(database.db, alarm.id);

    expect(Object.keys(statuses)).toHaveLength(200);

    for (const user of users) {
      const records = fake.recordsFor(clientRefOf(alarm.id, user));
      if (blocked.has(user)) {
        expect([user, statuses[user], records]).toEqual([user, 'FAILED', 0]);
      } else {
        expect([user, statuses[user], records]).toEqual([user, 'SENT', 1]);
      }
    }

    // 응답이 늦었던 건은 결과 확인으로 확정했다. 다시 보내지 않았다.
    for (const user of users.filter((u) => Number(u.slice(2)) % 25 === 0)) {
      expect(fake.received.filter((r) => r.recipientId === user)).toHaveLength(
        1,
      );
    }

    expect(workers.reduce((sum, w) => sum + w.fatal.length, 0)).toBe(0);
  });

  it('대량 발송 중에 시작한 긴급 알림이 먼저 나간다', async () => {
    fake.users = userIds(400);
    const bulk = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({ RATE_LIMIT_PER_SEC: '100', RATE_BUCKET_CAPACITY: '10' }, 2);
    await waitFor(async () => fake.received.length > 50);

    const urgentStartedAt = Date.now();
    const urgentRecipients = ['v_1', 'v_2', 'v_3', 'v_4', 'v_5'];
    const urgent = await insertAlarm(database.db, {
      type: 'URGENT',
      recipients: urgentRecipients,
    });

    await waitFor(
      async () => (await alarmStatus(database.db, urgent.id)) === 'COMPLETED',
      10_000,
    );

    const urgentPosts = fake.received.filter((r) => r.alarmId === urgent.id);

    expect(urgentPosts).toHaveLength(5);
    const lastUrgentAt = Math.max(...urgentPosts.map((r) => r.at));
    // 긴급 건이 대량 때문에 기다리는 시간은 이미 꺼내 둔 대량 묶음이 나가는 동안뿐이다 (워커당 최대 10건).
    const bulkBetween = fake.received.filter(
      (r) =>
        r.alarmId === bulk.id && r.at > urgentStartedAt && r.at < lastUrgentAt,
    );

    expect(bulkBetween.length).toBeLessThanOrEqual(2 * 10);
    expect(lastUrgentAt - urgentStartedAt).toBeLessThan(1000);
    expect(await alarmStatus(database.db, bulk.id)).toBe('SENDING');
  });

  it('워커 3대가 처리량 제한을 함께 지켜 외부 서비스가 429를 내지 않는다', async () => {
    fake.users = userIds(300);
    fake.enableRateLimit(100, 50); // mock과 같은 토큰 버킷: 거절된 요청은 토큰을 쓰지 않는다
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });
    const startedAt = Date.now();

    await start({ RATE_LIMIT_PER_SEC: '100', RATE_BUCKET_CAPACITY: '10' }, 3);
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      30_000,
    );
    const elapsedSec = (Date.now() - startedAt) / 1000;

    expect(fake.rateLimited).toBe(0);
    expect(fake.received).toHaveLength(300);
    // 처리량을 버리지 않는다: 300건 ÷ 초당 100 = 3초에 가깝다.
    expect(elapsedSec).toBeLessThan(6);

    // 0개를 받은 토큰 요청은 토큰 버킷 행의 헛된 갱신이다. 연달아 0개면 물러나므로 워커 셋이 다투어도 많지 않다 (ADR-0009).
    let emptyRequests = 0;

    for (const worker of workers) {
      const { values } = await worker.runtime.metrics.tokenRequests.get();

      emptyRequests +=
        values.find((v) => v.labels.result === 'empty')?.value ?? 0;
    }

    // 실측: 물러나지 않으면 약 730건, 물러나면 약 350건 (300건 발송)
    expect(emptyRequests).toBeLessThan(500);
  });

  it('펼치기는 저장된 커서부터 이어 가고 중복 행을 만들지 않는다 (ADR-0006)', async () => {
    const users = userIds(250);

    fake.users = users;
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    // 기한이 지난 워커(999)가 앞의 두 페이지(100명)를 넣고 커서를 저장한 상태
    for (const user of users.slice(0, 100)) {
      await database.db.execute(sql`
        INSERT INTO deliveries (alarm_id, recipient_id, priority, start_seq) VALUES (${alarm.id}, ${user}, 1, ${alarm.startSeq})`);
    }

    await database.db.execute(sql`
      UPDATE alarms SET expansion_owner = 999, expansion_lease_until = clock_timestamp() - interval '1 second',
             expansion_cursor = ${Buffer.from('100').toString('base64url')} WHERE id = ${alarm.id}`);

    await start();
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      30_000,
    );
    expect(
      Object.keys(await deliveryStatuses(database.db, alarm.id)),
    ).toHaveLength(250);

    for (const user of users) {
      expect(fake.recordsFor(clientRefOf(alarm.id, user))).toBe(1);
    }
  });

  it('사용자 조회가 다시 해도 안 되는 오류(401)로 실패하면, 재시도하지 않고 알림을 취소 처리하며 이유를 남긴다 (ADR-0006)', async () => {
    fake.users = userIds(100);
    fake.usersFailStatus = 401;
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start();
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'CANCELED',
    );
    const row = await database.db.execute<{
      cancel_reason: string;
      last_error_code: string;
    }>(
      sql`SELECT cancel_reason, last_error_code FROM alarms WHERE id = ${alarm.id}`,
    );

    expect(row.rows[0]).toEqual({
      cancel_reason: 'EXPANSION_FAILED',
      last_error_code: 'HTTP_401',
    });
    await sleep(500);
    expect(fake.usersRequests).toBe(1);
  });

  it('사용자 조회가 일시 오류로 실패하면 재시도해 끝까지 펼친다 (ADR-0006)', async () => {
    fake.users = userIds(100);
    fake.usersFailStatus = 503;
    setTimeout(() => (fake.usersFailStatus = null), 300);
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start();
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
    );

    expect(
      Object.keys(await deliveryStatuses(database.db, alarm.id)),
    ).toHaveLength(100);
    expect(fake.usersRequests).toBeGreaterThan(2);
  });

  it('사용자 조회가 계속 실패하는 동안 취소되면, 펼치기가 다음 조회 전에 멈춘다 (ADR-0006, 0017)', async () => {
    fake.users = userIds(100);
    fake.usersFailStatus = 503;
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start();
    await waitFor(async () => fake.usersRequests >= 2);
    await database.db.execute(
      sql`UPDATE alarms SET status = 'CANCELING' WHERE id = ${alarm.id}`,
    );
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'CANCELED',
    );
    // 이미 보낸 조회 하나는 끝날 수 있다. 그 뒤로는 재시도(최대 0.2초 간격)가 없어야 한다.
    const afterCancel = fake.usersRequests;

    await sleep(1000);
    expect(fake.usersRequests).toBeLessThanOrEqual(afterCancel + 1);
  });

  it('기한이 남은 펼치기 작업은 다른 워커가 맡지 않는다 (ADR-0004, 0006)', async () => {
    fake.users = userIds(50);
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await database.db.execute(sql`
      UPDATE alarms SET expansion_owner = 999, expansion_lease_until = clock_timestamp() + interval '1 minute'
       WHERE id = ${alarm.id}`);
    await start();
    await sleep(1000);

    expect(await deliveryStatuses(database.db, alarm.id)).toEqual({});
  });

  it('발송 중 취소하면 새 발송이 멈추고, 이미 보낸 건은 SENT로 남는다 (ADR-0017)', async () => {
    fake.users = userIds(300);
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({ RATE_LIMIT_PER_SEC: '100', RATE_BUCKET_CAPACITY: '10' });
    await waitFor(async () => fake.received.length > 40);

    await database.db.execute(
      sql`UPDATE alarms SET status = 'CANCELING' WHERE id = ${alarm.id} AND status = 'SENDING'`,
    );
    const canceledAt = Date.now();

    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'CANCELED',
      10_000,
    );

    // 취소 커밋 뒤에 새로 나간 요청은 이미 꺼내 둔 묶음뿐이다.
    expect(fake.received.filter((r) => r.at > canceledAt + 200)).toHaveLength(
      0,
    );
    const statuses = Object.entries(
      await deliveryStatuses(database.db, alarm.id),
    );

    for (const [user, status] of statuses) {
      expect([
        user,
        status,
        fake.recordsFor(clientRefOf(alarm.id, user)),
      ]).toEqual([user, status, status === 'SENT' ? 1 : 0]);
    }

    expect(statuses.filter(([, s]) => s === 'CANCELED').length).toBeGreaterThan(
      0,
    );
  });

  it('결과 확인은 외부 기록이 늦게 남는 만큼 기다린 뒤에 해서, 늦게 도착한 요청을 다시 보내지 않는다 (ADR-0002)', async () => {
    fake.users = userIds(20);
    // 첫 요청은 응답 타임아웃(500ms)보다 늦게(800ms) 기록된다. 결과 확인 대기(1000ms)가 그 차이를 덮어야 한다.
    fake.behavior = (_recipientId, attempt) =>
      attempt === 1
        ? { type: 'hang_then_record', hangMs: 800 }
        : { type: 'accept' };
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({ RECONCILE_DELAY_MS: '1000' });

    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      20_000,
    );

    for (const user of fake.users) {
      expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([
        user,
        1,
      ]);
    }
  });

  it('외부 서비스가 한동안 전부 실패해도 서킷 브레이커가 멈춰 기다리므로, 재시도를 다 써서 실패하는 건이 없다 (ADR-0014)', async () => {
    fake.users = userIds(100);
    // 브레이커가 없으면 재시도 8번(약 1초)을 2초 장애 안에 다 써서 FAILED가 된다.
    const outageUntil = Date.now() + 2000;

    fake.behavior = () =>
      Date.now() < outageUntil
        ? { type: 'error', status: 503 }
        : { type: 'accept' };
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({
      RATE_LIMIT_PER_SEC: '200',
      RATE_BUCKET_CAPACITY: '10',
      BREAKER_PAUSE_MIN_MS: '500',
      BREAKER_PAUSE_MAX_MS: '1000',
    });

    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      20_000,
    );
    const statuses = await deliveryStatuses(database.db, alarm.id);

    expect(Object.values(statuses).filter((s) => s !== 'SENT')).toEqual([]);

    for (const user of fake.users) {
      expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([
        user,
        1,
      ]);
    }
  });

  it('외부 장애가 브레이커 정지보다 훨씬 길게 이어져도 재시도를 다 써서 실패하는 건이 없고, 재개할 때는 시험 발송 한 건씩만 나간다 (ADR-0014)', async () => {
    fake.users = userIds(100);
    // 정지(0.1~0.4초)가 4초 장애 동안 여러 번 풀린다. 풀릴 때마다의 실패를 시도 횟수에 세면 앞쪽 건이 재시도 8번을 다 쓴다.
    const outageUntil = Date.now() + 4000;

    fake.behavior = () =>
      Date.now() < outageUntil
        ? { type: 'error', status: 503 }
        : { type: 'accept' };
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({
      RATE_LIMIT_PER_SEC: '200',
      RATE_BUCKET_CAPACITY: '10',
      BREAKER_PAUSE_MIN_MS: '100',
      BREAKER_PAUSE_MAX_MS: '400',
    });

    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      20_000,
    );
    const statuses = await deliveryStatuses(database.db, alarm.id);

    expect(Object.values(statuses).filter((s) => s !== 'SENT')).toEqual([]);

    for (const user of fake.users) {
      expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([
        user,
        1,
      ]);
    }

    // 장애 동안 나간 요청은 처음 발동하기 전의 수십 건과, 정지가 풀릴 때마다 시험 발송 한 건씩이다.
    // 시험 발송 없이 풀자마자 다 내보내면 풀릴 때마다 판단 창(20건)을 다시 채울 만큼 나간다.
    const sentDuringOutage = fake.received.filter(
      (r) => r.at < outageUntil,
    ).length;

    expect(sentDuringOutage).toBeLessThan(80);
  });

  it('정상 종료는 보낸 건의 결과를 기록하고 보내지 않은 건을 반납한다 (ADR-0007)', async () => {
    fake.users = userIds(120);
    fake.behavior = () => ({ type: 'accept', delayMs: 200 });
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      expansionDone: false,
    });

    await start({ RATE_LIMIT_PER_SEC: '100', RATE_BUCKET_CAPACITY: '10' });
    await waitFor(async () => fake.received.length > 20);

    const first = workers.shift()!;

    await first.runtime.stop();
    const leftovers = await database.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM deliveries WHERE owner = ${first.runtime.workerId} AND status = 'IN_FLIGHT'`);

    expect(leftovers.rows[0].n).toBe(0);

    await start();
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      30_000,
    );

    for (const user of fake.users) {
      expect(fake.recordsFor(clientRefOf(alarm.id, user))).toBe(1);
    }
  });
});
