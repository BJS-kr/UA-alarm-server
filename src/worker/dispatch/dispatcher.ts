import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import { decideAfterSend, SendDecision, SendResult } from '../../shared/domain/send-outcome';
import { clientRefOf } from '../../shared/domain/status';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { SendBreaker } from '../breaker/send-breaker';
import { WorkerSession } from '../lifecycle/worker-session';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { TokenBucket } from '../rate-limit/token-bucket';
import { durable, monotonicMs, sleep } from '../runtime/loop-utils';
import { retryOptions } from '../runtime/retry-options';
import { ClaimedDelivery, DeliveryStore } from './delivery-store';

export interface DispatcherDeps {
  config: AppConfig;
  store: DeliveryStore;
  bucket: TokenBucket;
  client: ExternalApiClient;
  session: WorkerSession;
  breaker: SendBreaker;
  metrics: WorkerMetrics;
  logger: LoggerService;
  onFatal: (reason: string, error?: unknown) => never;
}

/**
 * 작업 루프: 토큰 받기 → 꺼내기 → 보내기 → 결과 기록 (ADR-0009, 0011, 0013).
 * 토큰을 먼저 받아야 꺼내는 순간 가장 급한 건을 집는다. 꺼낸 건은 기다리지 않고 바로 보낸다.
 */
export class Dispatcher {
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private loopDone: Promise<void> = Promise.resolve();
  private lastTickAt = monotonicMs();

  constructor(private readonly deps: DispatcherDeps) {}

  start(): void {
    this.loopDone = this.loop();
  }

  /** 작업 루프가 최근에 돌았는가. worker의 생존 확인 기준이다 (ADR-0026). */
  isLive(): boolean {
    return monotonicMs() - this.lastTickAt < this.deps.config.LIVENESS_STALL_MS;
  }

  /** 새 건을 꺼내지 않고, 이미 보낸 요청의 결과 기록을 graceMs까지 기다린다 (ADR-0007). */
  async stop(graceMs: number): Promise<void> {
    this.stopping = true;
    await this.loopDone;
    await Promise.race([Promise.allSettled([...this.inFlight]), sleep(graceMs)]);
  }

  private async loop(): Promise<void> {
    const { config } = this.deps;
    while (!this.stopping) {
      this.lastTickAt = monotonicMs();
      try {
        if (!this.deps.session.canSend()) {
          await sleep(100);
          continue;
        }
        const free = config.MAX_IN_FLIGHT - this.inFlight.size;
        if (free <= 0) {
          await Promise.race(this.inFlight);
          continue;
        }
        const grant = await this.deps.bucket.acquire(Math.min(free, config.CLAIM_BATCH_MAX));
        if (grant.granted === 0) {
          await sleep(Math.min(Math.max(grant.waitMs, 5), config.IDLE_POLL_MS));
          continue;
        }
        const claimed = await this.deps.store.claim(grant.granted);
        if (claimed.length === 0) {
          // 꺼낼 건이 없으면 받은 토큰은 버린다. 할 일이 없을 때만 생기므로 처리량 손해가 없다.
          await sleep(config.IDLE_POLL_MS);
          continue;
        }
        for (const delivery of claimed) this.track(this.sendOne(delivery));
      } catch (error) {
        this.deps.logger.error('작업 루프 오류', error as Error);
        await sleep(config.IDLE_POLL_MS);
      }
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => this.deps.logger.error('발송 처리 오류', error as Error))
      .finally(() => {
        this.inFlight.delete(tracked);
        this.deps.metrics.inFlight.set(this.inFlight.size);
      });
    this.inFlight.add(tracked);
    this.deps.metrics.inFlight.set(this.inFlight.size);
  }

  private sendOne(delivery: ClaimedDelivery): Promise<void> {
    return withLogContext({ alarmId: delivery.alarmId, deliveryId: String(delivery.id), attempt: delivery.attempts }, () =>
      this.sendInContext(delivery),
    );
  }

  private async sendInContext(delivery: ClaimedDelivery): Promise<void> {
    const { config, store, client, metrics, logger, bucket, breaker } = this.deps;

    // 발송 직전 확인: 잠금 연결이 최근에 확인되지 않았으면 보내지 않고 반납한다 (ADR-0004).
    if (this.stopping || !this.deps.session.canSend()) {
      await this.persist(() => store.releaseUnsent(delivery));
      return;
    }

    const startedAt = monotonicMs();
    const result = await client.sendMessage(
      {
        alarmId: delivery.alarmId,
        recipientId: delivery.recipientId,
        body: delivery.body,
        clientRef: clientRefOf(delivery.alarmId, delivery.recipientId),
      },
      config.SEND_TIMEOUT_MS,
    );
    const priority = String(delivery.priority);
    metrics.sendRequests.inc({ priority, result: result.kind });
    metrics.sendDuration.observe({ priority }, (monotonicMs() - startedAt) / 1000);

    if (result.kind === 'rate_limited') {
      metrics.rateLimitPauses.inc();
      logger.warn('429를 받아 전체를 멈춘다', { retryAfterSec: result.retryAfterSec });
      await bucket.pauseFor(result.retryAfterSec * 1000).catch((e: unknown) => logger.error('정지 기록 실패', e as Error));
    }
    await breaker.record(result).catch((e: unknown) => logger.error('서킷 브레이커 기록 실패', e as Error));

    const decision = decideAfterSend(result, delivery.attempts, retryOptions(config));
    this.logDecision(delivery, result, decision);

    const outcome = await this.persist(() => store.recordSend(delivery, decision, config.RECONCILE_DELAY_MS));
    if (!outcome.applied) {
      await this.onFenced(delivery);
      return;
    }
    if (decision.kind === 'sent' && delivery.priority === 0 && delivery.alarmStartedAt) {
      metrics.urgentDispatchLatency.observe((Date.now() - delivery.alarmStartedAt.getTime()) / 1000);
    }
    if (outcome.finished) logger.log('알림 종료', { alarmId: delivery.alarmId, status: outcome.finished });
  }

  /**
   * 결과 기록이 펜싱에 걸렸다 = 그사이 다른 워커가 넘겨받았다.
   * clientRef로 실제 중복 여부를 확인해 남긴다 (ADR-0004). 조용히 넘어가지 않는다.
   */
  private async onFenced(delivery: ClaimedDelivery): Promise<void> {
    const { client, config, store, metrics, logger } = this.deps;
    metrics.fencedWrites.inc();
    const lookup = await client.lookupMessages(clientRefOf(delivery.alarmId, delivery.recipientId), config.LOOKUP_TIMEOUT_MS);
    if (lookup.kind === 'ok' && lookup.messages.length > 1) {
      metrics.duplicates.inc();
      await this.persist(() => store.markDuplicate(delivery.id));
      logger.error('중복 발송이 확인됐다', { recipientId: delivery.recipientId, messages: lookup.messages.length });
      return;
    }
    logger.warn('넘겨받힌 뒤 도착한 결과 기록을 버렸다', { recipientId: delivery.recipientId, lookup: lookup.kind });
  }

  private logDecision(delivery: ClaimedDelivery, result: SendResult, decision: SendDecision): void {
    const { logger } = this.deps;
    // debug에서는 Delivery와 겹치는 정보도 생략 없이 남긴다. 본문은 로거가 마스킹한다 (ADR-0028).
    logger.debug?.('발송 시도', {
      recipientId: delivery.recipientId,
      priority: delivery.priority,
      body: delivery.body,
      result,
      decision: decision.kind,
    });
    const fields = { recipientId: delivery.recipientId, decision: decision.kind };
    switch (decision.kind) {
      case 'sent':
        return;
      case 'failed':
        if (result.kind === 'rejected') logger.warn('영구 실패', { ...fields, code: decision.code });
        else logger.error('재시도를 모두 써서 실패로 확정한다', { ...fields, code: decision.code, message: decision.message });
        return;
      case 'retry':
        logger.warn('일시 오류로 재시도한다', { ...fields, code: decision.code, delayMs: decision.delayMs });
        return;
      case 'requeue_uncounted':
        return;
      case 'unconfirmed':
        logger.warn('결과를 알 수 없어 결과 확인으로 넘긴다', { ...fields, code: decision.code });
        return;
    }
  }

  private persist<T>(fn: () => Promise<T>): Promise<T> {
    return durable(fn, (error) => this.deps.onFatal('결과를 기록하지 못했다', error));
  }
}

