import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { decideAfterLookup } from '../../shared/domain/send-outcome';
import { clientRefOf } from '../../shared/domain/status';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { DeliveryStore, ReconcileItem } from '../dispatch/delivery-store';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { durable, sleep } from '../runtime/loop-utils';
import { retryOptions } from '../runtime/retry-options';

/**
 * 결과 확인 (ADR-0002). 보냈는지 모르는 건을 clientRef로 조회해 확정한다.
 * 기록이 있으면 SENT, 없으면 PENDING으로 되돌려 같은 꺼내기 경로로 다시 보낸다(토큰과 우선순위를 지킨다).
 * 조회가 실패하면 다시 보내지 않고 조회만 다시 한다.
 */
export class Reconciler {
  private stopping = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly store: DeliveryStore,
    private readonly client: ExternalApiClient,
    private readonly metrics: WorkerMetrics,
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
        const items = await this.store.claimReconcile(20, this.config.RECONCILE_CLAIM_LEASE_MS);
        if (items.length === 0) {
          await sleep(this.config.IDLE_POLL_MS);
          continue;
        }
        await Promise.all(items.map((item) => this.reconcile(item)));
      } catch (error) {
        this.logger.error('결과 확인 루프 오류', error as Error);
        await sleep(this.config.IDLE_POLL_MS);
      }
    }
  }

  private reconcile(item: ReconcileItem): Promise<void> {
    return withLogContext({ alarmId: item.alarmId, deliveryId: String(item.id), attempt: item.attempts }, async () => {
      const lookup = await this.client.lookupMessages(clientRefOf(item.alarmId, item.recipientId), this.config.LOOKUP_TIMEOUT_MS);
      const { decision, outcome } = await durable(
        () =>
          this.store.recordReconcile(item, (alarmCanceling) =>
            decideAfterLookup(lookup, alarmCanceling, item.attempts, retryOptions(this.config)),
          ),
        (error) => this.onFatal('결과 확인을 기록하지 못했다', error),
      );
      this.metrics.reconciles.inc({ result: decision.kind });
      if (decision.kind === 'sent' && decision.duplicate) {
        this.metrics.duplicates.inc();
        this.logger.error('중복 발송이 확인됐다', { recipientId: item.recipientId });
      }
      if (decision.kind === 'retry_lookup') {
        this.logger.warn('발송 내역 조회 실패, 조회만 다시 한다', { recipientId: item.recipientId, delayMs: decision.delayMs });
      }
      this.logger.debug?.('결과 확인', { recipientId: item.recipientId, lookup, decision, applied: outcome.applied });
      if (outcome.applied && outcome.finished) this.logger.log('알림 종료', { alarmId: item.alarmId, status: outcome.finished });
    });
  }
}
