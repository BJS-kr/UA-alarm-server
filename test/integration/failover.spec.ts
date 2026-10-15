import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { createPool } from '../../src/shared/db/database';
import { clientRefOf } from '../../src/shared/domain/status';
import { workerApplicationName } from '../../src/worker/lifecycle/worker-identity';
import { FakeExternalApi } from './support/fake-external-api';
import { alarmStatus, deliveryStatuses, insertAlarm, RunningWorker, startWorker, testConfig, userIds, waitFor } from './support/fixtures';
import { createTestDatabase, TestDatabase } from './support/test-database';

const COMPILED_WORKER = path.join(__dirname, '..', '..', 'dist', 'main-worker.js');

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
    await Promise.all(workers.map((w) => w.runtime.stop().catch(() => undefined)));
    for (const cleanup of extras) await cleanup().catch(() => undefined);
    await fake.stop();
    await database.drop();
  });

  /** 워커처럼 잠금을 잡은 세션. 생존 신호를 보내지 않으면 멈춘 워커와 같다. */
  async function fakeWorkerSession(workerId: number, heartbeat: boolean): Promise<{ client: Client; lost: Promise<void> }> {
    const client = new Client({ connectionString: database.url, application_name: workerApplicationName(workerId, 'lock') });
    let markLost!: () => void;
    const lost = new Promise<void>((resolve) => (markLost = resolve));
    client.on('error', () => markLost());
    client.on('end', () => markLost());
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1)', [workerId]);
    const timer = heartbeat ? setInterval(() => void client.query('SELECT 1').catch(() => undefined), 100) : undefined;
    extras.push(async () => {
      clearInterval(timer);
      await client.end();
    });
    return { client, lost };
  }

  /**
   * 컴파일된 워커를 별도 프로세스로 띄우고, 발송 도중(응답을 기다리는 건이 있을 때)까지 기다린다.
   * 워커가 남긴 로그(JSON 줄)를 함께 돌려준다.
   */
  async function spawnSendingWorker(): Promise<{ child: ChildProcess; logs: () => string }> {
    const child = spawn(process.execPath, [COMPILED_WORKER], {
      env: {
        ...process.env,
        DATABASE_URL: database.url,
        EXTERNAL_API_BASE_URL: fakeUrl,
        MANAGEMENT_PORT: '0',
        RATE_LIMIT_PER_SEC: '100',
        RATE_BUCKET_CAPACITY: '10',
        SEND_TIMEOUT_MS: '2000',
        RECONCILE_DELAY_MS: '100',
        HEARTBEAT_INTERVAL_MS: '100',
        SEND_GUARD_MS: '400',
        INVALIDATE_AFTER_MS: '1500',
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
    await waitFor(async () => {
      const inFlight = await database.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM deliveries WHERE status = 'IN_FLIGHT'`);
      return fake.received.length > 30 && inFlight.rows[0].n > 0;
    }, 20_000);
    return { child, logs: () => logs };
  }

  async function claimAs(workerId: number, alarmId: string, recipients: string[]): Promise<void> {
    await database.db.execute(sql`
      UPDATE deliveries SET status = 'IN_FLIGHT', owner = ${workerId}, attempts = 1, claimed_at = clock_timestamp()
       WHERE alarm_id = ${alarmId} AND recipient_id IN (${sql.join(recipients.map((r) => sql`${r}`), sql`, `)})`);
  }

  it('멈춘 워커는 무효로 선언되고, 넘겨받은 건 중 이미 보낸 건은 다시 보내지 않는다', async () => {
    const frozenId = 4242;
    const frozen = await fakeWorkerSession(frozenId, false);
    const alarm = await insertAlarm(database.db, { type: 'URGENT', recipients: ['r1', 'r2', 'r3'] });
    await claimAs(frozenId, alarm.id, ['r1', 'r2']);
    fake.preRecord(clientRefOf(alarm.id, 'r1'), 'r1'); // r1은 멈추기 직전에 보냈다

    await workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await frozen.lost; // 무효 선언으로 멈춘 워커의 세션이 끊긴다
    await waitFor(async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED', 15_000);

    expect(await deliveryStatuses(database.db, alarm.id)).toEqual({ r1: 'SENT', r2: 'SENT', r3: 'SENT' });
    expect(fake.received.filter((r) => r.recipientId === 'r1')).toHaveLength(0);
    for (const r of ['r1', 'r2', 'r3']) expect(fake.recordsFor(clientRefOf(alarm.id, r))).toBe(1);
    const metrics = await workers[0].runtime.metrics.registry.getSingleMetricAsString('alarm_takeovers_total');
    expect(metrics).toContain('alarm_takeovers_total 2');
  });

  it('알림 행 잠금을 쥔 채 멈춘 워커도 무효로 선언되고, 발송이 끝까지 간다', async () => {
    const frozenId = 4545;
    await fakeWorkerSession(frozenId, false);
    const recipients = Array.from({ length: 40 }, (_, i) => `r${i}`);
    const alarm = await insertAlarm(database.db, { type: 'URGENT', recipients });
    // 멈춘 워커의 풀 연결이 결과 기록 트랜잭션 도중(알림 행을 잠근 채) 멈췄다. 다른 워커의 결과 기록은 이 잠금을 기다린다.
    const stuck = new Client({ connectionString: database.url, application_name: workerApplicationName(frozenId, 'pool') });
    stuck.on('error', () => undefined);
    await stuck.connect();
    extras.push(() => stuck.end());
    await stuck.query('BEGIN');
    await stuck.query('SELECT 1 FROM alarms WHERE id = $1 FOR NO KEY UPDATE', [alarm.id]);

    workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await waitFor(async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED', 20_000);
    for (const r of recipients) expect([r, fake.recordsFor(clientRefOf(alarm.id, r))]).toEqual([r, 1]);
  });

  it('빌려 간 DB 연결이 서버 쪽에서 끊겨도 처리되지 않은 오류로 죽지 않는다', async () => {
    // 무효 선언(pg_terminate_backend)이나 DB 재시작은 트랜잭션 도중의 연결도 끊는다. 풀은 쉬는 연결의 오류만 받아 준다.
    const errors: Error[] = [];
    const pool = createPool(database.url, 'alarm-test:pool', 1, (error) => errors.push(error));
    extras.push(() => pool.end());
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await database.db.execute(sql`SELECT pg_terminate_backend(${rows[0].pid})`);
    await waitFor(async () => errors.length > 0, 5_000);
    client.release(true);
  });

  it('생존 신호를 보내는 워커의 건은 넘겨받지 않는다', async () => {
    const aliveId = 4343;
    await fakeWorkerSession(aliveId, true);
    const alarm = await insertAlarm(database.db, { type: 'URGENT', recipients: ['r1', 'r2'] });
    await claimAs(aliveId, alarm.id, ['r1']);

    workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await waitFor(async () => (await deliveryStatuses(database.db, alarm.id)).r2 === 'SENT');
    await new Promise((r) => setTimeout(r, 2500)); // 무효 선언 기준(1.5초)을 넘겨 기다린다
    expect((await deliveryStatuses(database.db, alarm.id)).r1).toBe('IN_FLIGHT');
    expect(fake.received.filter((r) => r.recipientId === 'r1')).toHaveLength(0);
  });

  (existsSync(COMPILED_WORKER) ? it : it.skip)('발송 중 강제 종료된 워커의 건을 이어서 정확히 한 번씩 보낸다 (SIGKILL)', async () => {
    fake.users = userIds(150);
    fake.behavior = () => ({ type: 'accept', delayMs: 300 });
    const alarm = await insertAlarm(database.db, { type: 'BULK', expansionDone: false });

    const { child } = await spawnSendingWorker();
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await waitFor(async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED', 30_000);
    for (const user of fake.users) expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([user, 1]);
    const metrics = await workers[0].runtime.metrics.registry.getSingleMetricAsString('alarm_duplicates_detected_total');
    expect(metrics).toContain('alarm_duplicates_detected_total 0');
  });

  // SIGSTOP은 Windows에 없다. 테스트 컨테이너(Linux)에서 실행된다.
  (existsSync(COMPILED_WORKER) && process.platform !== 'win32' ? it : it.skip)(
    '멈췄다 깨어난 워커 프로세스는 무효 선언을 알아채고 더 보내지 않은 채 종료한다 (SIGSTOP)',
    async () => {
      fake.users = userIds(150);
      fake.behavior = () => ({ type: 'accept', delayMs: 300 });
      const alarm = await insertAlarm(database.db, { type: 'BULK', expansionDone: false });

      const { child, logs } = await spawnSendingWorker();
      // 'exit'는 표준 출력을 다 읽기 전에 올 수 있다. 종료 사유 로그까지 보려면 'close'를 기다린다.
      const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
      process.kill(child.pid!, 'SIGSTOP');

      // 멈춘 동안 다른 워커가 무효로 선언하고 넘겨받아 끝낸다.
      workers.push(await startWorker(testConfig(database.url, fakeUrl)));
      await waitFor(async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED', 30_000);
      const invalidations = await workers[0].runtime.metrics.registry.getSingleMetricAsString('alarm_worker_invalidations_total');
      expect(invalidations).not.toContain('alarm_worker_invalidations_total 0');

      // 깨어난 워커는 잠금을 잃은 것을 알아채고 종료한다. 다른 이유(기록 실패 등)로 죽은 것과 구별하려고 종료 사유를 본다.
      // 그 뒤에도 수신자마다 기록은 정확히 한 번이다.
      process.kill(child.pid!, 'SIGCONT');
      expect(await exited).toBe(1);
      expect(logs()).toMatch(/"level":"fatal"[^\n]*잠금을 잃었다/);
      await new Promise((r) => setTimeout(r, 500));
      for (const user of fake.users) expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([user, 1]);
    },
  );
});
