import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { DeliveryRepository } from '../dispatch/delivery.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { invalidateSilentWorkers } from './workers.repository';

/**
 * 살아 있는 워커 누구나 주기적으로 하는 두 가지 (ADR-0004). 따로 감시 프로세스를 두지 않는다.
 * - 무효 선언: 잠금 연결이 조용한 워커의 세션을 끊는다.
 * - 넘겨받기: 주인이 명단에 없는 IN_FLIGHT 건을 결과 미확정으로 돌린다.
 * db와 deliveries는 무효 선언 전용 연결을 쓴다. 다른 워커가 쥔 잠금 때문에 기본 풀이 막혀도 무효 선언은 돈다.
 */
export class Housekeeper {
  private readonly loop: PollingLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly deliveries: DeliveryRepository,
    private readonly workerId: number,
    private readonly metrics: WorkerMetrics,
    private readonly logger: LoggerService,
  ) {
    this.loop = new PollingLoop(
      {
        name: 'housekeeping',
        idleMs: config.HEARTBEAT_INTERVAL_MS,
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
    const terminatedSessions = await invalidateSilentWorkers(
      this.db,
      this.workerId,
      this.config.INVALIDATE_AFTER_MS,
    );
    const isInvalidated = terminatedSessions > 0;
    if (isInvalidated) {
      this.metrics.invalidations.inc(terminatedSessions);
      this.logger.warn('Invalidated unresponsive workers', {
        terminatedSessions,
      });
    }

    const takenOver = await this.deliveries.takeOverOrphans(
      this.config.RECONCILE_DELAY_MS,
    );
    const isTakenOver = takenOver > 0;
    if (isTakenOver) {
      this.metrics.takeovers.inc(takenOver);
      this.logger.warn('Took over deliveries whose worker is gone', {
        deliveries: takenOver,
      });
    }

    return 'idle';
  }
}
