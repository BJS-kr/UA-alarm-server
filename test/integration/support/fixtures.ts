import { LoggerService } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppConfig, loadConfig } from '../../../src/shared/config/app-config';
import { Db } from '../../../src/shared/db/database';
import { newWorkerId } from '../../../src/worker/lifecycle/worker-identity';
import { WorkerRuntime } from '../../../src/worker/runtime/worker-runtime';

/** 시간 기준값을 짧게 줄여 실제 시간으로 빠르게 돌린다 (ADR-0034 기준 4). 관계 검증은 그대로 지킨다. */
export function testConfig(databaseUrl: string, externalUrl: string, overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(
    {
      DATABASE_URL: databaseUrl,
      EXTERNAL_API_BASE_URL: externalUrl,
      SEND_TIMEOUT_MS: '500',
      LOOKUP_TIMEOUT_MS: '500',
      USERS_TIMEOUT_MS: '500',
      RECONCILE_DELAY_MS: '100',
      RECONCILE_CLAIM_LEASE_MS: '2000',
      USERS_PAGE_SIZE: '50',
      RATE_LIMIT_PER_SEC: '1000',
      RATE_BUCKET_CAPACITY: '50',
      RETRY_BASE_MS: '20',
      RETRY_MAX_MS: '200',
      RETRY_JITTER_RATIO: '0',
      HEARTBEAT_INTERVAL_MS: '100',
      SEND_GUARD_MS: '400',
      INVALIDATE_AFTER_MS: '1500',
      IDLE_POLL_MS: '30',
      SHUTDOWN_GRACE_MS: '3000',
      ...overrides,
    },
    'worker',
  );
}

export interface LogEntry {
  level: string;
  message: unknown;
  params: unknown[];
}

/** 아무것도 출력하지 않고 남긴 로그를 모아 둔다. 로그 내용으로 탐지 여부를 확인할 때 쓴다. */
export class CapturingLogger implements LoggerService {
  readonly entries: LogEntry[] = [];
  log(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: 'log', message, params });
  }
  error(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: 'error', message, params });
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: 'warn', message, params });
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: 'debug', message, params });
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.entries.push({ level: 'fatal', message, params });
  }
}

export interface RunningWorker {
  runtime: WorkerRuntime;
  logger: CapturingLogger;
  fatal: string[];
}

/** 같은 프로세스 안에서 DB 연결과 워커 ID를 따로 가진 워커 인스턴스를 띄운다 (ADR-0035). */
export async function startWorker(config: AppConfig, workerId = newWorkerId()): Promise<RunningWorker> {
  const logger = new CapturingLogger();
  const fatal: string[] = [];
  const runtime = new WorkerRuntime({
    config,
    workerId,
    logger,
    onFatal: (reason) => {
      fatal.push(reason);
      throw new Error(`fatal: ${reason}`);
    },
  });
  await runtime.start();
  return { runtime, logger, fatal };
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs = 20_000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('기다리던 상태가 되지 않았다');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** API를 거치지 않고 알림을 원하는 상태로 만든다. 시작 순번은 시퀀스에서 받는다. */
export async function insertAlarm(
  db: Db,
  options: { type: 'BULK' | 'URGENT'; status?: string; recipients?: string[]; expansionDone?: boolean; title?: string },
): Promise<{ id: string; startSeq: number }> {
  const status = options.status ?? 'SENDING';
  const started = status !== 'CREATED';
  const result = await db.execute<{ id: string; start_seq: number }>(sql`
    INSERT INTO alarms (type, title, body, status, start_seq, started_at, expansion_done)
    VALUES (${options.type}, ${options.title ?? '테스트'}, ${'본문 482913'}, ${status},
            ${started ? sql`nextval('alarm_start_seq')` : sql`NULL`}, ${started ? sql`clock_timestamp()` : sql`NULL`},
            ${options.expansionDone ?? options.type === 'URGENT'})
    RETURNING id, start_seq`);
  const alarm = result.rows[0];
  if (options.recipients?.length) {
    const priority = options.type === 'URGENT' ? 0 : 1;
    for (const recipientId of options.recipients) {
      await db.execute(sql`
        INSERT INTO deliveries (alarm_id, recipient_id, priority, start_seq)
        VALUES (${alarm.id}, ${recipientId}, ${priority}, ${alarm.start_seq ?? 0})`);
    }
  }
  return { id: alarm.id, startSeq: alarm.start_seq };
}

export async function alarmStatus(db: Db, alarmId: string): Promise<string> {
  const result = await db.execute<{ status: string }>(sql`SELECT status FROM alarms WHERE id = ${alarmId}`);
  return result.rows[0].status;
}

export async function deliveryStatuses(db: Db, alarmId: string): Promise<Record<string, string>> {
  const result = await db.execute<{ recipient_id: string; status: string }>(
    sql`SELECT recipient_id, status FROM deliveries WHERE alarm_id = ${alarmId}`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.recipient_id, row.status]));
}

export function userIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `u_${String(i + 1).padStart(6, '0')}`);
}
