import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { DeliveryRepository } from '../dispatch/delivery.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { PollingLoop, Tick } from '../runtime/polling-loop';

/**
 * 리스 만료 회수(Takeover, ADR-0004). 모든 활성 워커가 주기적으로 lease_until이 경과한 IN_FLIGHT 건을
 * UNCONFIRMED로 전이한다. 만료 판정은 DB 시각(clock_timestamp)을 기준으로 수행한다.
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
