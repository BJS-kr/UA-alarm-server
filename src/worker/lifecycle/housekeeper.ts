import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { DeliveryRepository } from '../dispatch/delivery.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { PollingLoop, Tick } from '../runtime/polling-loop';

/**
 * 넘겨받기 (ADR-0004). 살아 있는 워커 누구나 주기적으로, 기한이 지난 IN_FLIGHT 건을 결과 미확정으로 돌린다.
 * 따로 감시 프로세스를 두지 않는다. 기한 판단은 DB 시계로 하므로 워커끼리 시계가 달라도 된다.
 */
export class Housekeeper {
  private readonly loop: PollingLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly deliveries: DeliveryRepository,
    private readonly metrics: WorkerMetrics,
    private readonly logger: LoggerService,
  ) {
    this.loop = new PollingLoop(
      {
        name: 'housekeeping',
        idleMs: config.HOUSEKEEPING_INTERVAL_MS,
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
    const takenOver = await this.deliveries.takeOverExpired(
      this.config.RECONCILE_DELAY_MS,
    );
    const isTakenOver = takenOver > 0;
    if (isTakenOver) {
      this.metrics.takeovers.inc(takenOver);
      this.logger.warn('Took over deliveries whose lease expired', {
        deliveries: takenOver,
      });
    }

    return 'idle';
  }
}
