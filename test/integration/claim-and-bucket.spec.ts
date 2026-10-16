import { sql } from 'drizzle-orm';
import { DeliveryRepository } from '../../src/worker/dispatch/delivery.repository';
import { TokenBucket } from '../../src/worker/rate-limit/token-bucket';
import { insertAlarm, userIds } from './support/fixtures';
import { createTestDatabase, TestDatabase } from './support/test-database';

describe('꺼내기 (ADR-0011, 0012, 0017)', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database.drop();
  });

  it('긴급이 먼저, 같은 우선순위에서는 먼저 시작한 알림이 먼저 나온다', async () => {
    const bulkA = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['a1', 'a2'],
    });
    const bulkB = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['b1', 'b2'],
    });
    const urgent = await insertAlarm(database.db, {
      type: 'URGENT',
      recipients: ['u1'],
    });
    const store = new DeliveryRepository(database.db, 1);
    // 순서가 아니라 "토큰 수(LIMIT)만큼만 꺼낼 때 무엇을 고르는가"가 우선순위다. 한 건씩 꺼내 고른 순서를 본다.
    const picked: Array<{
      recipientId: string;
      alarmId: string;
      attempts: number;
    }> = [];

    for (let i = 0; i < 5; i++) picked.push(...(await store.claim(1, 30_000)));
    expect(picked.map((d) => d.recipientId)).toEqual([
      'u1',
      'a1',
      'a2',
      'b1',
      'b2',
    ]);
    expect(picked.map((d) => d.alarmId)).toEqual([
      urgent.id,
      bulkA.id,
      bulkA.id,
      bulkB.id,
      bulkB.id,
    ]);
    expect(picked.every((d) => d.attempts === 1)).toBe(true);
  });

  it('재시도 시각이 안 된 건은 꺼내지 않고, 시각이 되면 원래 자리로 돌아온다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['r1', 'r2', 'r3'],
    });

    await database.db.execute(sql`
      UPDATE deliveries SET next_attempt_at = clock_timestamp() + interval '1 hour'
       WHERE alarm_id = ${alarm.id} AND recipient_id = 'r1'`);
    const store = new DeliveryRepository(database.db, 1);

    expect((await store.claim(10, 30_000)).map((d) => d.recipientId)).toEqual([
      'r2',
      'r3',
    ]);

    const later = await insertAlarm(database.db, {
      type: 'BULK',
      recipients: ['l1'],
    });

    await database.db.execute(
      sql`UPDATE deliveries SET next_attempt_at = clock_timestamp() WHERE recipient_id = 'r1'`,
    );
    const next = await store.claim(10, 30_000);

    expect(next.map((d) => d.recipientId)).toEqual(['r1', 'l1']);
    expect(next[1].alarmId).toBe(later.id);
  });

  it('SENDING이 아닌 알림의 건은 꺼내지 않는다 (취소 1단계 직후 새 발송이 없다)', async () => {
    await insertAlarm(database.db, {
      type: 'BULK',
      status: 'CANCELING',
      recipients: ['c1'],
    });
    await insertAlarm(database.db, {
      type: 'BULK',
      status: 'CREATED',
      recipients: ['x1'],
    });
    expect(
      await new DeliveryRepository(database.db, 1).claim(10, 30_000),
    ).toEqual([]);
  });

  it('여러 워커가 동시에 꺼내도 같은 건을 두 번 집지 않는다 (SKIP LOCKED)', async () => {
    await insertAlarm(database.db, { type: 'BULK', recipients: userIds(300) });
    const stores = [1, 2, 3, 4].map(
      (id) => new DeliveryRepository(database.db, id),
    );
    const seen: number[] = [];
    let round: number[];

    do {
      const batches = await Promise.all(
        stores.map((store) => store.claim(10, 30_000)),
      );

      round = batches.flat().map((d) => d.id);
      seen.push(...round);
    } while (round.length > 0);

    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
  });
});

describe('토큰 버킷 (ADR-0009)', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database.drop();
  });

  it('한 번에 통 크기 이상은 받지 못한다', async () => {
    const bucket = new TokenBucket(database.db, 50, 10, 30_000);

    // 버킷은 마이그레이션 시점에 비어 있다. 0.2초면 통 크기(10)만큼 찬다.
    await new Promise((r) => setTimeout(r, 300));
    expect((await bucket.acquire(100)).granted).toBe(10);
    const empty = await bucket.acquire(5);

    expect(empty.granted).toBe(0);
    expect(empty.waitMs).toBeGreaterThan(0);
    expect(empty.waitMs).toBeLessThanOrEqual(20);
  });

  it('여러 워커가 동시에 받아도 합계가 충전 속도를 넘지 않는다', async () => {
    const bucket = new TokenBucket(database.db, 100, 10, 30_000);

    await bucket.acquire(10); // 처음 차 있는 몫을 비운다
    const started = Date.now();
    let granted = 0;
    const workers = Array.from({ length: 6 }, async () => {
      while (Date.now() - started < 1000) {
        const grant = await bucket.acquire(10);

        granted += grant.granted;

        if (grant.granted === 0) {
          await new Promise((r) => setTimeout(r, Math.max(1, grant.waitMs)));
        }
      }
    });

    await Promise.all(workers);
    const elapsedSec = (Date.now() - started) / 1000;

    expect(granted).toBeLessThanOrEqual(Math.ceil(100 * elapsedSec) + 10);
    expect(granted).toBeGreaterThan(100 * elapsedSec * 0.8);
  });

  it('정지 중에는 토큰을 주지 않고 남은 시간을 알려 준다 (429)', async () => {
    const bucket = new TokenBucket(database.db, 50, 10, 30_000);

    // 통이 차 있어야 0개가 "정지라서"인지 "토큰이 없어서"인지 구별된다.
    await new Promise((r) => setTimeout(r, 300));
    await bucket.pauseFor(1000);
    const grant = await bucket.acquire(5);

    expect(grant.granted).toBe(0);
    expect(grant.waitMs).toBeGreaterThan(800);
  });

  it('브레이커가 열린 뒤 정지가 풀리면 시험 발송 한 건만 내주고, 닫히면 평소대로 낸다 (ADR-0014)', async () => {
    const bucket = new TokenBucket(database.db, 50, 10, 30_000);
    const options = {
      pauseMinMs: 100,
      pauseMaxMs: 1000,
      streakWindowMs: 60_000,
    };

    await new Promise((r) => setTimeout(r, 300)); // 통이 찬다
    await bucket.tripBreaker(options);
    expect(await bucket.acquire(5)).toMatchObject({
      granted: 0,
      isBreakerOpen: true,
    });
    await new Promise((r) => setTimeout(r, 150)); // 정지가 풀린다

    expect(await bucket.acquire(5)).toMatchObject({
      granted: 1,
      isProbe: true,
      isBreakerOpen: true,
    });
    // 시험 발송이 나가 있는 동안에는 아무도 받지 못한다. 기다릴 시간은 시험 발송의 기한까지다.
    const waiting = await bucket.acquire(5);

    expect(waiting).toMatchObject({ granted: 0, isProbe: false });
    expect(waiting.waitMs).toBeGreaterThan(20_000);

    // 시험 발송 토큰을 쓰지 않고 돌려주면 바로 다시 시험할 수 있다.
    await bucket.releaseProbe();
    expect((await bucket.acquire(5)).isProbe).toBe(true);

    await bucket.closeBreaker();
    expect(await bucket.acquire(5)).toMatchObject({
      isProbe: false,
      isBreakerOpen: false,
    });
    expect((await bucket.acquire(5)).granted).toBeGreaterThan(1);
  });

  it('시험 발송이 실패해 다시 열면 정지 시간이 두 배가 된다 (ADR-0014)', async () => {
    const bucket = new TokenBucket(database.db, 50, 10, 30_000);
    const options = {
      pauseMinMs: 100,
      pauseMaxMs: 1000,
      streakWindowMs: 60_000,
    };

    await bucket.tripBreaker(options);
    await new Promise((r) => setTimeout(r, 150));
    // 정지가 풀린 뒤 시험 발송이 실패했다
    expect(await bucket.tripBreaker(options)).toEqual({
      tripped: true,
      pauseMs: 200,
      streak: 1,
    });
    expect((await bucket.acquire(5)).granted).toBe(0);
  });

  it('서킷 브레이커는 이미 정지 중이면 발동하지 않고, 연달아 발동하면 정지 시간이 두 배가 된다 (ADR-0014)', async () => {
    const bucket = new TokenBucket(database.db, 50, 10, 30_000);
    const options = {
      pauseMinMs: 100,
      pauseMaxMs: 1000,
      streakWindowMs: 60_000,
    };

    expect(await bucket.tripBreaker(options)).toEqual({
      tripped: true,
      pauseMs: 100,
      streak: 0,
    });
    expect((await bucket.tripBreaker(options)).tripped).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(await bucket.tripBreaker(options)).toEqual({
      tripped: true,
      pauseMs: 200,
      streak: 1,
    });
  });
});
