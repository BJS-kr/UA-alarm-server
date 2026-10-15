import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { Db } from '../../shared/db/database';
import { DeliveryStore } from '../dispatch/delivery-store';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { sleep } from '../runtime/loop-utils';
import { invalidateSilentWorkers } from './invalidator';

/**
 * 살아 있는 워커 누구나 주기적으로 하는 두 가지 (ADR-0004). 따로 감시 프로세스를 두지 않는다.
 * - 무효 선언: 잠금 연결이 조용한 워커의 세션을 끊는다.
 * - 넘겨받기: 주인이 명단에 없는 IN_FLIGHT 건을 결과 미확정으로 돌린다.
 */
export class Housekeeper {
  private stopping = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly store: DeliveryStore,
    private readonly workerId: number,
    private readonly metrics: WorkerMetrics,
    private readonly logger: LoggerService,
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
        const terminated = await invalidateSilentWorkers(this.db, this.workerId, this.config.INVALIDATE_AFTER_MS);
        if (terminated > 0) {
          this.metrics.invalidations.inc(terminated);
          this.logger.warn('응답 없는 워커를 무효로 선언했다', { terminatedSessions: terminated });
        }
        const taken = await this.store.takeOverOrphans(this.config.RECONCILE_DELAY_MS);
        if (taken > 0) {
          this.metrics.takeovers.inc(taken);
          this.logger.warn('주인이 사라진 건을 넘겨받았다', { deliveries: taken });
        }
      } catch (error) {
        this.logger.error('관리 루프 오류', error as Error);
      }
      await sleep(this.config.HEARTBEAT_INTERVAL_MS);
    }
  }
}
