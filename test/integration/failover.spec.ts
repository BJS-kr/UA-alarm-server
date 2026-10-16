import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, createPool } from '../../src/shared/db/database';
import { SendResult } from '../../src/shared/domain/send-outcome';
import { clientRefOf } from '../../src/shared/domain/status';
import { ExternalApiClient } from '../../src/shared/external/external-api.client';
import { SendBreaker } from '../../src/worker/breaker/send-breaker';
import { DeliveryRepository } from '../../src/worker/dispatch/delivery.repository';
import { Dispatcher } from '../../src/worker/dispatch/dispatcher';
import { WorkerMetrics } from '../../src/worker/metrics/worker-metrics';
import { TokenBucket } from '../../src/worker/rate-limit/token-bucket';
import { sleep } from '../../src/worker/runtime/loop-utils';
import { createWorkerPool } from '../../src/worker/runtime/worker-runtime';
import { FakeExternalApi } from './support/fake-external-api';
import {
  alarmStatus,
  CapturingLogger,
  deliveryStatuses,
  insertAlarm,
  RunningWorker,
  startWorker,
  testConfig,
  userIds,
  waitFor,
} from './support/fixtures';
import { createTestDatabase, TestDatabase } from './support/test-database';

const COMPILED_WORKER = path.join(
  __dirname,
  '..',
  '..',
  'dist',
  'main-worker.js',
);

describe('워커 장애 (ADR-0004, 0007)', () => {
  let database: TestDatabase;
  let fake: FakeExternalApi;
  let fakeUrl: string;
  let workers: RunningWorker[];
  let extras: Array<() => Promise<void>>;

  beforeEach(async () => {
    database = await createTestDatabase();
    fake = new FakeExternalApi();
    fakeUrl = await fake.start();
    workers = [];
    extras = [];
  });

  afterEach(async () => {
    await Promise.all(
      workers.map((w) => w.runtime.stop().catch(() => undefined)),
    );
    for (const cleanup of extras) await cleanup().catch(() => undefined);
    await fake.stop();
    await database.drop();
  });

  /** 컴파일된 워커를 별도 프로세스로 띄운다. 워커가 남긴 로그(JSON 줄)를 함께 돌려준다. */
  function spawnWorker(): { child: ChildProcess; logs: () => string } {
    const child = spawn(process.execPath, [COMPILED_WORKER], {
      env: {
        ...process.env,
        DATABASE_URL: database.url,
        EXTERNAL_API_BASE_URL: fakeUrl,
        MANAGEMENT_PORT: '0',
        RATE_LIMIT_PER_SEC: '100',
        RATE_BUCKET_CAPACITY: '10',
        SEND_TIMEOUT_MS: '2000',
        USERS_TIMEOUT_MS: '1000',
        RECONCILE_DELAY_MS: '100',
        DELIVERY_LEASE_MS: '2500',
        TASK_LEASE_MS: '2500',
        HOUSEKEEPING_INTERVAL_MS: '100',
        IDLE_TX_TIMEOUT_MS: '1000',
        IDLE_POLL_MS: '30',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';

    child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
    extras.push(async () => {
      child.kill('SIGKILL');
    });

    return { child, logs: () => logs };
  }

  /** spawnWorker로 띄우고, 발송 도중(응답을 기다리는 건이 있을 때)까지 기다린다. */
  async function spawnSendingWorker(): Promise<{
    child: ChildProcess;
    logs: () => string;
  }> {
    const worker = spawnWorker();

    await waitFor(async () => {
      const inFlight = await database.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM deliveries WHERE status = 'IN_FLIGHT'`,
      );

      return fake.received.length > 30 && inFlight.rows[0].n > 0;
    }, 20_000);

    return worker;
  }

  /** 다른 워커가 건을 쥔 상태를 만든다. leaseMs가 0 이하면 이미 기한이 지났다. */
  async function claimAs(
    workerId: number,
    alarmId: string,
    recipients: string[],
    leaseMs: number,
  ): Promise<void> {
    await database.db.execute(sql`
      UPDATE deliveries SET status = 'IN_FLIGHT', owner = ${workerId}, attempts = 1, claimed_at = clock_timestamp(),
             lease_until = clock_timestamp() + make_interval(secs => ${leaseMs / 1000})
       WHERE alarm_id = ${alarmId} AND recipient_id IN (${sql.join(
         recipients.map((r) => sql`${r}`),
         sql`, `,
       )})`);
  }

  it('기한이 지난 건은 넘겨받고, 그중 이미 보낸 건은 다시 보내지 않는다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'URGENT',
      recipients: ['r1', 'r2', 'r3'],
    });

    await claimAs(4242, alarm.id, ['r1', 'r2'], -1000);
    fake.preRecord(clientRefOf(alarm.id, 'r1'), 'r1'); // r1은 멈추기 직전에 보냈다

    workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      15_000,
    );

    expect(await deliveryStatuses(database.db, alarm.id)).toEqual({
      r1: 'SENT',
      r2: 'SENT',
      r3: 'SENT',
    });
    expect(fake.received.filter((r) => r.recipientId === 'r1')).toHaveLength(0);

    for (const r of ['r1', 'r2', 'r3']) {
      expect(fake.recordsFor(clientRefOf(alarm.id, r))).toBe(1);
    }

    const metrics =
      await workers[0].runtime.metrics.registry.getSingleMetricAsString(
        'alarm_takeovers_total',
      );

    expect(metrics).toContain('alarm_takeovers_total 2');
  });

  it('기한이 남은 건은 넘겨받지 않는다', async () => {
    const alarm = await insertAlarm(database.db, {
      type: 'URGENT',
      recipients: ['r1', 'r2'],
    });

    await claimAs(4343, alarm.id, ['r1'], 60_000);

    workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await waitFor(
      async () => (await deliveryStatuses(database.db, alarm.id)).r2 === 'SENT',
    );
    await sleep(1000); // 넘겨받기 루프(0.1초 주기)가 여러 번 돌 시간
    expect((await deliveryStatuses(database.db, alarm.id)).r1).toBe(
      'IN_FLIGHT',
    );
    expect(fake.received.filter((r) => r.recipientId === 'r1')).toHaveLength(0);
  });

  it('트랜잭션 도중 멈춘 워커가 쥔 알림 행 잠금은 Postgres가 풀고, 발송이 끝까지 간다', async () => {
    const config = testConfig(database.url, fakeUrl);
    const recipients = Array.from({ length: 40 }, (_, i) => `r${i}`);
    const alarm = await insertAlarm(database.db, {
      type: 'URGENT',
      recipients,
    });
    // 워커와 같은 설정의 연결이 결과 기록 트랜잭션 도중(알림 행을 잠근 채) 멈췄다. 다른 워커의 결과 기록은 이 잠금을 기다린다.
    const frozenPool = createWorkerPool(config, 4545, 1);
    const frozen = await frozenPool.connect();

    frozen.on('error', () => undefined);
    extras.push(async () => {
      frozen.release(true);
      await frozenPool.end();
    });
    await frozen.query('BEGIN');
    await frozen.query('SELECT 1 FROM alarms WHERE id = $1 FOR NO KEY UPDATE', [
      alarm.id,
    ]);

    workers.push(await startWorker(config));
    await waitFor(
      async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
      20_000,
    );

    for (const r of recipients) {
      expect([r, fake.recordsFor(clientRefOf(alarm.id, r))]).toEqual([r, 1]);
    }
  });

  it('빌려 간 DB 연결이 서버 쪽에서 끊겨도 처리되지 않은 오류로 죽지 않는다', async () => {
    // 트랜잭션 유휴 한도나 DB 재시작은 트랜잭션 도중의 연결도 끊는다. 풀은 쉬는 연결의 오류만 받아 준다.
    const errors: Error[] = [];
    const pool = createPool(database.url, 'alarm-test:pool', 1, (error) =>
      errors.push(error),
    );

    extras.push(() => pool.end());
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );

    await database.db.execute(sql`SELECT pg_terminate_backend(${rows[0].pid})`);
    await waitFor(async () => errors.length > 0, 5_000);
    client.release(true);
  });

  (existsSync(COMPILED_WORKER) ? it : it.skip)(
    '발송 중 강제 종료된 워커의 건을 기한이 지난 뒤 이어서 정확히 한 번씩 보낸다 (SIGKILL)',
    async () => {
      fake.users = userIds(150);
      fake.behavior = () => ({ type: 'accept', delayMs: 300 });
      const alarm = await insertAlarm(database.db, {
        type: 'BULK',
        expansionDone: false,
      });

      const { child } = await spawnSendingWorker();

      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));

      workers.push(await startWorker(testConfig(database.url, fakeUrl)));
      await waitFor(
        async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
        30_000,
      );

      for (const user of fake.users) {
        expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([
          user,
          1,
        ]);
      }

      const metrics =
        await workers[0].runtime.metrics.registry.getSingleMetricAsString(
          'alarm_duplicates_detected_total',
        );

      expect(metrics).toContain('alarm_duplicates_detected_total 0');
    },
  );

  // SIGSTOP은 Windows에 없다. 테스트 컨테이너(Linux)에서 실행된다.
  (existsSync(COMPILED_WORKER) && process.platform !== 'win32' ? it : it.skip)(
    '멈췄다 깨어난 워커 프로세스는 넘겨받힌 건의 결과를 펜싱에 막히고, 종료하지 않고 계속 일한다 (SIGSTOP)',
    async () => {
      fake.users = userIds(150);
      fake.behavior = () => ({ type: 'accept', delayMs: 300 });
      const alarm = await insertAlarm(database.db, {
        type: 'BULK',
        expansionDone: false,
      });

      const { child, logs } = await spawnSendingWorker();

      process.kill(child.pid!, 'SIGSTOP');

      // 멈춘 동안 기한(2.5초)이 지나 다른 워커가 넘겨받는다. 넘겨받은 건은 결과 확인 대기(3초) 뒤에 조회한다.
      const survivor = await startWorker(
        testConfig(database.url, fakeUrl, { RECONCILE_DELAY_MS: '3000' }),
      );

      workers.push(survivor);
      await waitFor(
        async () =>
          (await survivor.runtime.metrics.takeovers.get()).values[0]?.value > 0,
      );

      // 넘겨받은 직후, 결과 확인 대기가 끝나기 전에 깨운다. 설계가 약속하는 범위다(ADR-0002, 0004).
      // 확인을 통과하고 소켓에 쓰기 직전에 멈췄던 요청이 깨어나며 나가도, 그 기록은 조회보다 먼저 남아 다시 보내지 않는다.
      // 대기보다 오래 멈추면 이 틈에서 중복이 날 수 있다. 문서에 남긴 남은 틈이다.
      process.kill(child.pid!, 'SIGCONT');
      await waitFor(
        async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
        30_000,
      );

      for (const user of fake.users) {
        expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([
          user,
          1,
        ]);
      }

      // 멈춘 동안 받아 둔 응답은 깨어난 뒤 기록하려다 펜싱에 걸리고, 조회로 중복이 아님을 확인한다.
      await waitFor(async () =>
        logs().includes(
          'Dropped a result that arrived after the delivery was taken over',
        ),
      );
      // 기한이 지난 건은 이미 남의 것이고 쓰기는 펜싱이 막으므로, 깨어난 워커는 종료하지 않는다.
      expect(child.exitCode).toBeNull();
      expect(logs()).not.toMatch(/"level":"fatal"/);
    },
  );

  (existsSync(COMPILED_WORKER) ? it : it.skip)(
    '강제 종료된 워커 프로세스를 같은 설정으로 다시 띄워도(재시작) 이전 생의 건을 넘겨받아 끝낸다',
    async () => {
      fake.users = userIds(150);
      fake.behavior = () => ({ type: 'accept', delayMs: 300 });
      const alarm = await insertAlarm(database.db, {
        type: 'BULK',
        expansionDone: false,
      });

      const first = await spawnSendingWorker();

      first.child.kill('SIGKILL');
      await new Promise((resolve) => first.child.once('exit', resolve));
      // restart 정책이 같은 컨테이너를 다시 띄운 것과 같다. 이전 생의 건은 기한이 지나 넘겨받는다.
      spawnWorker();
      await waitFor(
        async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED',
        30_000,
      );

      for (const user of fake.users) {
        expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([
          user,
          1,
        ]);
      }
    },
  );

  it('꺼낸 뒤 소켓에 쓰기 직전에 남은 기한이 모자라면 보내지 않고 시도 횟수와 브레이커에 세지 않은 채 대기로 돌린다', async () => {
    // 기한 0.7초, 응답 한도 0.5초: 꺼낸 뒤 0.2초 안에 써야 보낼 수 있다.
    const config = testConfig(database.url, fakeUrl, {
      DELIVERY_LEASE_MS: '700',
    });
    const alarm = await insertAlarm(database.db, {
      type: 'URGENT',
      recipients: ['r1'],
    });
    let requested = false;
    const recorded: SendResult[] = [];

    // 요청을 만들기 전에 0.3초 걸린다. 연결을 기다리는 사이에 멈췄다 깨어난 경우와 같다.
    // 같은 건을 다시 꺼내지 않도록 첫 요청 뒤에 루프를 멈춘다.
    class SlowClient extends ExternalApiClient {
      override async sendMessage(
        ...args: Parameters<ExternalApiClient['sendMessage']>
      ) {
        requested = true;
        void dispatcher.stop(0);
        await sleep(300);

        return super.sendMessage(...args);
      }
    }
    const client = new SlowClient(fakeUrl, 5);
    const pool = createWorkerPool(config, 4747, 2);
    const db = createDb(pool);

    const dispatcher = new Dispatcher({
      config,
      deliveries: new DeliveryRepository(db, 4747),
      bucket: new TokenBucket(db, 1000, 50, 30_000),
      client,
      breaker: {
        observe: () => undefined,
        isOpen: () => false,
        record: async (result: SendResult) => {
          recorded.push(result);
        },
      } as unknown as SendBreaker,
      metrics: new WorkerMetrics(),
      logger: new CapturingLogger(),
      onFatal: (reason) => {
        throw new Error(reason);
      },
    });

    dispatcher.start();
    extras.push(async () => {
      await dispatcher.stop(0);
      client.close();
      await pool.end();
    });

    await waitFor(
      async () =>
        requested &&
        (await deliveryStatuses(database.db, alarm.id)).r1 === 'PENDING',
      5_000,
    );
    expect(fake.received).toHaveLength(0);
    // 외부 장애가 아니므로 브레이커가 보지 않고, 이 건의 시도 횟수도 쓰지 않는다.
    expect(recorded).toEqual([]);
    const row = await database.db.execute<{ attempts: number }>(
      sql`SELECT attempts FROM deliveries WHERE alarm_id = ${alarm.id}`,
    );

    expect(row.rows[0].attempts).toBe(0);
  });
});
