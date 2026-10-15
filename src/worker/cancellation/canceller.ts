import { LoggerService } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { AlarmStatus } from '../../shared/domain/status';
import { withLogContext } from '../../shared/logging/log-context';
import { withAlarmLock } from '../completion/alarm-transaction';
import { ownerIsGone } from '../lifecycle/alive-workers';
import { durable, sleep } from '../runtime/loop-utils';

/**
 * 취소 2단계: 대기 건 정리 (ADR-0017). API는 알림을 CANCELING으로만 바꾸고 바로 응답하며,
 * 정리는 워커가 펼치기와 같은 점유 방식으로 쥐고 한다. API가 1단계 직후 죽어도 정리는 이어진다.
 */
export class Canceller {
  private stopping = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly workerId: number,
    private readonly logger: LoggerService,
    private readonly onFatal: (reason: string, error?: unknown) => never,
  ) {}

  start(): void {
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        const alarmId = await this.claimTask();
        if (!alarmId) {
          await sleep(this.config.IDLE_POLL_MS);
          continue;
        }
        await withLogContext({ alarmId }, () => this.cleanUp(alarmId));
      } catch (error) {
        this.logger.error('취소 정리 루프 오류', error as Error);
        await sleep(this.config.IDLE_POLL_MS);
      }
    }
  }

  private async claimTask(): Promise<string | undefined> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE alarms
         SET cleanup_owner = ${this.workerId}
       WHERE id = (
         SELECT id FROM alarms
          WHERE status = 'CANCELING' AND NOT cleanup_done
            AND (cleanup_owner IS NULL OR ${ownerIsGone(sql`cleanup_owner`)})
          LIMIT 1
            FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    return result.rows[0]?.id;
  }

  private async cleanUp(alarmId: string): Promise<void> {
    const { result: canceled, finished } = await durable(
      () =>
        withAlarmLock(this.db, alarmId, async (tx, alarm) => {
          if (alarm.status !== AlarmStatus.CANCELING || alarm.cleanupOwner !== this.workerId) return 0;
          const updated = await tx.execute(sql`
            UPDATE deliveries SET status = 'CANCELED', updated_at = clock_timestamp()
             WHERE alarm_id = ${alarmId} AND status = 'PENDING'`);
          await tx.execute(sql`UPDATE alarms SET cleanup_done = true WHERE id = ${alarmId}`);
          return updated.rowCount ?? 0;
        }),
      (error) => this.onFatal('취소 정리를 기록하지 못했다', error),
    );
    this.logger.log('취소 정리 완료', { canceledDeliveries: canceled, finished });
  }
}
