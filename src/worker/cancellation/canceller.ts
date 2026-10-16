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
 * 취소 2단계: PENDING Delivery 일괄 취소 처리 (ADR-0017).
 * API는 알림을 CANCELING으로만 전이하여 즉시 응답하고, 실제 PENDING 정리는 워커가 리스 기반으로 점유해 수행한다.
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
    const { result: canceledDeliveries, finished } = await durable(() =>
      withAlarmLock(this.db, alarmId, async (tx, alarm) => {
        const isCanceling = alarm.status === AlarmStatus.CANCELING;
        const isMine = alarm.cleanupOwner === this.workerId;
        const isMyCleanup = isCanceling && isMine;
        if (!isMyCleanup) return 0;

        return this.repository.cancelPending(tx, alarmId);
      }),
    );

    this.logger.log('Cancel cleanup finished', {
      canceledDeliveries,
      finished,
    });
  }
}
