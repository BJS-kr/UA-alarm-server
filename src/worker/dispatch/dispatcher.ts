import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import {
  decideAfterSend,
  SendDecision,
  SendResult,
} from '../../shared/domain/send-outcome';
import { clientRefOf } from '../../shared/domain/status';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { SendBreaker } from '../breaker/send-breaker';
import { WorkerSession } from '../lifecycle/worker-session';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { TokenBucket } from '../rate-limit/token-bucket';
import { durable, monotonicMs, waitAtMost } from '../runtime/loop-utils';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { retryOptions } from '../runtime/retry-options';
import { ClaimedDelivery, DeliveryRepository } from './delivery.repository';

/** 잠금 확인이 낡았을 때 다시 확인하기까지 쉬는 시간. 생존 신호가 오면 바로 이어 간다. */
const LOCK_RECHECK_MS = 100;
/** 토큰이 없을 때 최소로 쉬는 시간. */
const MIN_TOKEN_WAIT_MS = 5;

export interface DispatcherDeps {
  config: AppConfig;
  deliveries: DeliveryRepository;
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
  private readonly loop: PollingLoop;

  constructor(private readonly deps: DispatcherDeps) {
    this.loop = new PollingLoop(
      {
        name: 'dispatch',
        idleMs: deps.config.IDLE_POLL_MS,
        logger: deps.logger,
        onError: (loop) => deps.metrics.loopErrors.inc({ loop }),
      },
      () => this.tick(),
    );
  }

  start(): void {
    this.loop.start();
  }

  /** 작업 루프가 최근에 돌았는가. worker의 생존 확인 기준이다 (ADR-0026). */
  isLive(): boolean {
    return this.loop.isTurning(this.deps.config.LIVENESS_STALL_MS);
  }

  /** 새 건을 꺼내지 않고, 이미 보낸 요청의 결과 기록을 graceMs까지 기다린다 (ADR-0007). */
  async stop(graceMs: number): Promise<void> {
    await this.loop.stop();
    await waitAtMost(Promise.allSettled([...this.inFlight]), graceMs);
  }

  private async tick(): Promise<Tick> {
    const { config, session, bucket, deliveries } = this.deps;
    const isLockFresh = session.canSend();
    if (!isLockFresh) return { sleepMs: LOCK_RECHECK_MS };

    const free = config.MAX_IN_FLIGHT - this.inFlight.size;
    const isAtCapacity = free <= 0;
    if (isAtCapacity) {
      await Promise.race(this.inFlight);

      return 'busy';
    }

    const grant = await bucket.acquire(Math.min(free, config.CLAIM_BATCH_MAX));
    const isOutOfTokens = grant.granted === 0;
    if (isOutOfTokens) {
      return {
        sleepMs: Math.min(
          Math.max(grant.waitMs, MIN_TOKEN_WAIT_MS),
          config.IDLE_POLL_MS,
        ),
      };
    }

    const claimed = await deliveries.claim(grant.granted);
    // 꺼낼 건이 없으면 받은 토큰은 버린다. 할 일이 없을 때만 생기므로 처리량 손해가 없다.
    const isNothingToSend = claimed.length === 0;
    if (isNothingToSend) return 'idle';

    for (const delivery of claimed) this.track(this.sendOne(delivery));

    return 'busy';
  }

  /** 보내는 건 하나는 루프와 따로 돈다. 예상하지 못한 오류가 나도 루프와 다른 건에 번지지 않게 여기서 받는다. */
  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.deps.metrics.loopErrors.inc({ loop: 'send' });
        this.deps.logger.error(
          'Sending a delivery failed unexpectedly',
          error as Error,
        );
      })
      .finally(() => {
        this.inFlight.delete(tracked);
        this.deps.metrics.inFlight.set(this.inFlight.size);
      });

    this.inFlight.add(tracked);
    this.deps.metrics.inFlight.set(this.inFlight.size);
  }

  private sendOne(delivery: ClaimedDelivery): Promise<void> {
    return withLogContext(
      {
        alarmId: delivery.alarmId,
        deliveryId: String(delivery.id),
        attempt: delivery.attempts,
      },
      () => this.sendInContext(delivery),
    );
  }

  private async sendInContext(delivery: ClaimedDelivery): Promise<void> {
    const { config, deliveries, client, metrics, logger, bucket, breaker } =
      this.deps;

    // 발송 직전 확인: 잠금 연결이 최근에 확인되지 않았으면 보내지 않고 반납한다 (ADR-0004).
    const isShuttingDown = this.loop.isStopping;
    const isLockFresh = this.deps.session.canSend();
    const isSendBlocked = isShuttingDown || !isLockFresh;
    if (isSendBlocked) {
      await this.persist(() => deliveries.releaseUnsent(delivery));

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
      () => this.deps.session.canSend(),
    );
    const priority = String(delivery.priority);

    metrics.sendRequests.inc({ priority, result: result.kind });
    metrics.sendDuration.observe(
      { priority },
      (monotonicMs() - startedAt) / 1000,
    );

    const isRateLimited = result.kind === 'rate_limited';
    if (isRateLimited) {
      metrics.rateLimitPauses.inc();
      logger.warn('Got 429, pausing all workers', {
        retryAfterSec: result.retryAfterSec,
      });
      // 정지 기록이 실패해도 이 건의 결과는 기록해야 하므로 여기서 받는다.
      await bucket
        .pauseFor(result.retryAfterSec * 1000)
        .catch((e: unknown) =>
          logger.error('Could not record the pause', e as Error),
        );
    }

    await breaker
      .record(result)
      .catch((e: unknown) =>
        logger.error('Could not record the circuit breaker result', e as Error),
      );

    const decision = decideAfterSend(
      result,
      delivery.attempts,
      retryOptions(config),
    );

    this.logDecision(delivery, result, decision);

    const outcome = await this.persist(() =>
      deliveries.recordSend(delivery, decision, config.RECONCILE_DELAY_MS),
    );
    const isApplied = outcome.applied === true;
    if (!isApplied) {
      await this.onFenced(delivery);

      return;
    }

    const isUrgentSent =
      decision.kind === 'sent' &&
      delivery.priority === 0 &&
      delivery.alarmStartedAt !== null;
    if (isUrgentSent) {
      metrics.urgentDispatchLatency.observe(
        (Date.now() - delivery.alarmStartedAt!.getTime()) / 1000,
      );
    }

    const isAlarmFinished = outcome.finished !== null;
    if (isAlarmFinished) {
      logger.log('Alarm finished', {
        alarmId: delivery.alarmId,
        status: outcome.finished,
      });
    }
  }

  /**
   * 결과 기록이 펜싱에 걸렸다 = 그사이 다른 워커가 넘겨받았다.
   * clientRef로 실제 중복 여부를 확인해 남긴다 (ADR-0004). 조용히 넘어가지 않는다.
   */
  private async onFenced(delivery: ClaimedDelivery): Promise<void> {
    const { client, config, deliveries, metrics, logger } = this.deps;

    metrics.fencedWrites.inc();
    const lookup = await client.lookupMessages(
      clientRefOf(delivery.alarmId, delivery.recipientId),
      config.LOOKUP_TIMEOUT_MS,
    );
    const isDuplicate = lookup.kind === 'ok' && lookup.messages.length > 1;
    if (isDuplicate) {
      metrics.duplicates.inc();
      await this.persist(() => deliveries.markDuplicate(delivery.id));
      logger.error('Duplicate send confirmed', {
        recipientId: delivery.recipientId,
        messages: lookup.messages.length,
      });

      return;
    }

    logger.warn(
      'Dropped a result that arrived after the delivery was taken over',
      { recipientId: delivery.recipientId, lookup: lookup.kind },
    );
  }

  private logDecision(
    delivery: ClaimedDelivery,
    result: SendResult,
    decision: SendDecision,
  ): void {
    const { logger } = this.deps;

    // debug에서는 Delivery와 겹치는 정보도 생략 없이 남긴다. 본문은 로거가 마스킹한다 (ADR-0028).
    logger.debug?.('Send attempt', {
      recipientId: delivery.recipientId,
      priority: delivery.priority,
      body: delivery.body,
      result,
      decision: decision.kind,
    });
    const fields = {
      recipientId: delivery.recipientId,
      decision: decision.kind,
    };

    switch (decision.kind) {
      case 'sent':
      case 'requeue_uncounted':
        return;
      case 'failed': {
        const isRejected = result.kind === 'rejected';
        if (isRejected) {
          logger.warn('Recipient rejected, giving up', {
            ...fields,
            code: decision.code,
          });
        } else {
          logger.error('All retries used, giving up', {
            ...fields,
            code: decision.code,
            message: decision.message,
          });
        }

        return;
      }
      case 'retry':
        logger.warn('Transient error, retrying', {
          ...fields,
          code: decision.code,
          delayMs: decision.delayMs,
        });

        return;
      case 'unconfirmed':
        logger.warn('Outcome unknown, handing over to reconcile', {
          ...fields,
          code: decision.code,
        });

        return;
    }
  }

  private persist<T>(fn: () => Promise<T>): Promise<T> {
    return durable(fn, (error) =>
      this.deps.onFatal('Could not record a send result', error),
    );
  }
}
