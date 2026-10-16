import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { decideAfterLookup } from '../../shared/domain/send-outcome';
import { clientRefOf } from '../../shared/domain/status';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import {
  DeliveryRepository,
  ReconcileItem,
} from '../dispatch/delivery.repository';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { durable } from '../runtime/loop-utils';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { retryOptions } from '../runtime/retry-options';

/** 한 바퀴에 결과를 확인하는 최대 건수. */
const RECONCILE_BATCH = 20;

/**
 * 결과 확인 (ADR-0002). 보냈는지 모르는 건을 clientRef로 조회해 확정한다.
 * 기록이 있으면 SENT, 없으면 PENDING으로 되돌려 같은 꺼내기 경로로 다시 보낸다(토큰과 우선순위를 지킨다).
 * 조회가 실패하면 다시 보내지 않고 조회만 다시 한다.
 */
export class Reconciler {
  private readonly loop: PollingLoop;

  constructor(
    private readonly config: AppConfig,
    private readonly deliveries: DeliveryRepository,
    private readonly client: ExternalApiClient,
    private readonly metrics: WorkerMetrics,
    private readonly logger: LoggerService,
  ) {
    this.loop = new PollingLoop(
      {
        name: 'reconcile',
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
    const items = await this.deliveries.claimReconcile(
      RECONCILE_BATCH,
      this.config.RECONCILE_CLAIM_LEASE_MS,
    );
    const isIdle = items.length === 0;
    if (isIdle) return 'idle';
    await Promise.all(items.map((item) => this.reconcile(item)));

    return 'busy';
  }

  private reconcile(item: ReconcileItem): Promise<void> {
    return withLogContext(
      {
        alarmId: item.alarmId,
        deliveryId: String(item.id),
        attempt: item.attempts,
      },
      async () => {
        const lookup = await this.client.lookupMessages(
          clientRefOf(item.alarmId, item.recipientId),
          this.config.LOOKUP_TIMEOUT_MS,
        );
        const { decision, outcome } = await durable(() =>
          this.deliveries.recordReconcile(item, (isAlarmCanceling) =>
            decideAfterLookup(
              lookup,
              isAlarmCanceling,
              item,
              retryOptions(this.config),
            ),
          ),
        );

        this.metrics.reconciles.inc({ result: decision.kind });
        const isDuplicate = decision.kind === 'sent' && decision.duplicate;
        if (isDuplicate) {
          this.metrics.duplicates.inc();
          this.logger.error('Duplicate send confirmed', {
            recipientId: item.recipientId,
          });
        }

        const isLookupRetry = decision.kind === 'retry_lookup';
        if (isLookupRetry) {
          this.logger.warn('Message lookup failed, retrying the lookup only', {
            recipientId: item.recipientId,
            delayMs: decision.delayMs,
          });
        }

        this.logger.debug?.('Reconciled', {
          recipientId: item.recipientId,
          lookup,
          decision,
          applied: outcome.applied,
        });
        const isAlarmFinished = outcome.applied && outcome.finished !== null;
        if (isAlarmFinished) {
          this.logger.log('Alarm finished', {
            alarmId: item.alarmId,
            status: outcome.finished,
          });
        }
      },
    );
  }
}
