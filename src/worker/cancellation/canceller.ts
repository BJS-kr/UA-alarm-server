import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { AlarmStatus } from '../../shared/domain/status';
import { withLogContext } from '../../shared/logging/log-context';
import { withAlarmLock } from '../completion/alarm-lock.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { durable } from '../runtime/loop-utils';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { CancellationRepository } from './cancellation.repository';

/**
 * 취소 2단계: 대기 건 정리 (ADR-0017). API는 알림을 CANCELING으로만 바꾸고 바로 응답하며,
 * 정리는 워커가 펼치기와 같은 점유 방식으로 쥐고 한다. API가 1단계 직후 죽어도 정리는 이어진다.
 */
export class Canceller {
  private readonly loop: PollingLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly repository: CancellationRepository,
    private readonly workerId: number,
    metrics: WorkerMetrics,
    private readonly logger: LoggerService,
    private readonly onFatal: (reason: string, error?: unknown) => never,
  ) {
    this.loop = new PollingLoop(
      {
        name: 'cancellation',
        idleMs: config.IDLE_POLL_MS,
        logger,
        onError: (loop) => metrics.loopErrors.inc({ loop }),
      },
      () => this.tick(),
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  private async tick(): Promise<Tick> {
    const alarmId = await this.repository.claim(this.config.TASK_LEASE_MS);
    const isIdle = alarmId === undefined;
    if (isIdle) return 'idle';
    await withLogContext({ alarmId }, () => this.cleanUp(alarmId));

    return 'busy';
  }

  private async cleanUp(alarmId: string): Promise<void> {
    const { result: canceledDeliveries, finished } = await durable(
      () =>
        withAlarmLock(this.db, alarmId, async (tx, alarm) => {
          const isCanceling = alarm.status === AlarmStatus.CANCELING;
          const isMine = alarm.cleanupOwner === this.workerId;
          const isMyCleanup = isCanceling && isMine;
          if (!isMyCleanup) return 0;

          return this.repository.cancelPending(tx, alarmId);
        }),
      (error) => this.onFatal('Could not record the cancel cleanup', error),
    );

    this.logger.log('Cancel cleanup finished', {
      canceledDeliveries,
      finished,
    });
  }
}
