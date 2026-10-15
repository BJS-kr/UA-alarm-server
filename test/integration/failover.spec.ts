import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
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

    const child: ChildProcess = spawn(process.execPath, [COMPILED_WORKER], {
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
      stdio: 'ignore',
    });
    extras.push(async () => {
      child.kill('SIGKILL');
    });
    await waitFor(async () => {
      const inFlight = await database.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM deliveries WHERE status = 'IN_FLIGHT'`);
      return fake.received.length > 30 && inFlight.rows[0].n > 0;
    }, 20_000);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    workers.push(await startWorker(testConfig(database.url, fakeUrl)));
    await waitFor(async () => (await alarmStatus(database.db, alarm.id)) === 'COMPLETED', 30_000);
    for (const user of fake.users) expect([user, fake.recordsFor(clientRefOf(alarm.id, user))]).toEqual([user, 1]);
    const metrics = await workers[0].runtime.metrics.registry.getSingleMetricAsString('alarm_duplicates_detected_total');
    expect(metrics).toContain('alarm_duplicates_detected_total 0');
  });
});
