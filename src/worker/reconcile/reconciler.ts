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

/** 폴링 주기당 상태 확정 최대 처리 건수. */
const RECONCILE_BATCH = 20;

/**
 * 발송 내역 조회 및 상태 확정(Reconciliation, ADR-0002). 결과 미확정(UNCONFIRMED) 건을 clientRef로 조회해 확정한다.
 * 발송 기록이 존재하면 SENT로, 없으면 PENDING으로 복귀시켜 일반 발송 경로(토큰 버킷 및 우선순위 적용)로 재발송한다.
 * 조회 자체가 실패한 경우 재발송하지 않고 조회만 재시도한다.
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
