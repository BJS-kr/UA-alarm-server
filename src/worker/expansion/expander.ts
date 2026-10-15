import { LoggerService } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { deliveries } from '../../shared/db/schema';
import { retryDelayMs } from '../../shared/domain/retry-policy';
import { AlarmStatus } from '../../shared/domain/status';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { withAlarmLock } from '../completion/alarm-transaction';
import { ownerIsGone } from '../lifecycle/alive-workers';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { durable, sleep } from '../runtime/loop-utils';

interface ExpansionTask {
  alarmId: string;
  cursor: string | null;
  startSeq: number;
}

/**
 * 수신자 펼치기 (ADR-0006). 알림 하나의 펼치기는 한 번에 한 워커만 쥔다.
 * 페이지마다 "Delivery 삽입 + 다음 커서 저장"을 한 트랜잭션으로 커밋하므로, 죽으면 넘겨받은 워커가 저장된 커서부터 잇는다.
 * 커밋된 Delivery는 즉시 발송 대상이 된다. 발송 모듈과는 DB 테이블로만 이어진다.
 */
export class Expander {
  private stopping = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly workerId: number,
    private readonly client: ExternalApiClient,
    private readonly metrics: WorkerMetrics,
    private readonly logger: LoggerService,
    private readonly onFatal: (reason: string, error?: unknown) => never,
  ) {}

  start(): void {
    this.loopDone = this.loop();
  }

  /** 진행 중이면 현재 페이지를 커밋하고 멈춘다 (ADR-0007). */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const task = await this.claimTask();
        if (!task) {
          await sleep(this.config.IDLE_POLL_MS);
          continue;
        }
        await withLogContext({ alarmId: task.alarmId }, () => this.expand(task));
      } catch (error) {
        this.logger.error('펼치기 루프 오류', error as Error);
        await sleep(this.config.IDLE_POLL_MS);
      }
    }
  }

  /** 아무도 쥐지 않았거나 주인이 사라진 펼치기 작업을 쥔다. 먼저 시작한 알림부터 (ADR-0012). */
  private async claimTask(): Promise<ExpansionTask | undefined> {
    const result = await this.db.execute<{ id: string; expansion_cursor: string | null; start_seq: number }>(sql`
      UPDATE alarms
         SET expansion_owner = ${this.workerId}
       WHERE id = (
         SELECT id FROM alarms
          WHERE status = 'SENDING' AND NOT expansion_done
            AND (expansion_owner IS NULL OR ${ownerIsGone(sql`expansion_owner`)})
          ORDER BY start_seq
          LIMIT 1
            FOR UPDATE SKIP LOCKED)
      RETURNING id, expansion_cursor, start_seq`);
    const row = result.rows[0];
    return row ? { alarmId: row.id, cursor: row.expansion_cursor, startSeq: row.start_seq } : undefined;
  }

  private async expand(task: ExpansionTask): Promise<void> {
    let cursor = task.cursor;
    let failures = 0;
    this.logger.log('펼치기 시작', { fromCursor: cursor });
    while (!this.stopping) {
      const page = await this.client.listUsers(cursor, this.config.USERS_PAGE_SIZE, this.config.USERS_TIMEOUT_MS);
      if (page.kind === 'error') {
        failures += 1;
        const delayMs = retryDelayMs(failures, { baseMs: this.config.RETRY_BASE_MS, maxMs: this.config.RETRY_MAX_MS, jitterRatio: this.config.RETRY_JITTER_RATIO });
        this.logger.warn('사용자 조회 실패, 다시 시도한다', { code: page.code, delayMs });
        await sleep(delayMs);
        continue;
      }
      failures = 0;
      const pageCursor = cursor;
      const { result: step, finished } = await durable(
        () =>
          withAlarmLock(this.db, task.alarmId, async (tx, alarm) => {
            // 취소됐거나, 넘겨받혔거나, 이미 다른 워커가 이 페이지를 넣었으면 멈춘다.
            if (alarm.status !== AlarmStatus.SENDING || alarm.expansionOwner !== this.workerId || alarm.expansionCursor !== pageCursor) {
              return 'stop' as const;
            }
            if (page.users.length > 0) {
              await tx
                .insert(deliveries)
                .values(page.users.map((user) => ({ alarmId: task.alarmId, recipientId: user.id, priority: 1, startSeq: task.startSeq })))
                .onConflictDoNothing();
            }
            const done = page.nextCursor === null;
            await tx.execute(sql`
              UPDATE alarms SET expansion_cursor = ${page.nextCursor}, expansion_done = ${done}
               WHERE id = ${task.alarmId} AND expansion_owner = ${this.workerId}`);
            return done ? ('done' as const) : ('continue' as const);
          }),
        (error) => this.onFatal('펼치기 페이지를 기록하지 못했다', error),
      );
      if (step !== 'stop') this.metrics.expansionPages.inc();
      if (step === 'done') this.logger.log('펼치기 완료', { finished });
      if (step !== 'continue') return;
      cursor = page.nextCursor;
    }
  }
}
