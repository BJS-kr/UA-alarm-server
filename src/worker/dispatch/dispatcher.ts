import { LoggerService } from '@nestjs/common';
import { AppConfig } from '../../shared/config/app-config';
import {
  decideAfterSend,
  SendDecision,
  SendResult,
} from '../../shared/domain/send-outcome';
import { hasLeaseFor } from '../../shared/domain/lease';
import {
  TOKEN_WAIT_MAX_MS,
  tokenRetryWaitMs,
} from '../../shared/domain/retry-policy';
import { clientRefOf } from '../../shared/domain/status';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { withLogContext } from '../../shared/logging/log-context';
import { SendBreaker } from '../breaker/send-breaker';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { TokenBucket } from '../rate-limit/token-bucket';
import { durable, monotonicMs, waitAtMost } from '../runtime/loop-utils';
import { PollingLoop, Tick } from '../runtime/polling-loop';
import { retryOptions } from '../runtime/retry-options';
import { ClaimedDelivery, DeliveryRepository } from './delivery.repository';

export interface DispatcherDeps {
  config: AppConfig;
  deliveries: DeliveryRepository;
  bucket: TokenBucket;
  client: ExternalApiClient;
  breaker: SendBreaker;
  metrics: WorkerMetrics;
  logger: LoggerService;
}

/**
 * 발송 루프: 토큰 획득 → 대상 점유(claim) → 외부 발송 → 결과 기록 (ADR-0009, 0011, 0013).
 * 토큰을 선획득한 뒤 점유해야 점유 시점 기준 최우선순위 건을 즉시 발송할 수 있다.
 */
export class Dispatcher {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly loop: PollingLoop;
  /** 연속으로 토큰을 0개 획득한 횟수. 토큰 획득 시 0으로 초기화된다 (ADR-0009). */
  private emptyGrants = 0;

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

  /** 발송 루프가 지정 시간 내에 실행되었는지 확인한다 (워커 liveness 기준, ADR-0026). */
  isLive(): boolean {
    return this.loop.isTurning(this.deps.config.LIVENESS_STALL_MS);
  }

  /** 신규 점유를 중단하고 진행 중인 발송 요청의 결과 기록을 graceMs까지 대기한다 (ADR-0007). */
  async stop(graceMs: number): Promise<void> {
    await this.loop.stop();
    await waitAtMost(Promise.allSettled([...this.inFlight]), graceMs);
  }

  private async tick(): Promise<Tick> {
    const { config, bucket, deliveries } = this.deps;
    const free = config.MAX_IN_FLIGHT - this.inFlight.size;
    const isAtCapacity = free <= 0;
    if (isAtCapacity) {
      await Promise.race(this.inFlight);

      return 'busy';
    }

    const grant = await bucket.acquire(Math.min(free, config.CLAIM_BATCH_MAX));

    this.deps.breaker.observe(grant.isBreakerOpen);
    const isOutOfTokens = grant.granted === 0;

    this.deps.metrics.tokenRequests.inc({
      result: isOutOfTokens ? 'empty' : 'granted',
    });
    if (isOutOfTokens) return { sleepMs: this.waitForTokens(grant.waitMs) };
    this.emptyGrants = 0;

    // 리스 만료 시각은 claim 쿼리 직전의 단조 시계 기준으로 계산하여 DB의 lease_until보다 항상 보수적으로 판정한다 (ADR-0004).
    const claimStartedAt = monotonicMs();
    const claimed = await deliveries.claim(
      grant.granted,
      config.DELIVERY_LEASE_MS,
    );
    const leaseDeadline = claimStartedAt + config.DELIVERY_LEASE_MS;
    // 점유할 대상이 없으면 획득한 토큰은 소멸시킨다.
    const isNothingToSend = claimed.length === 0;
    if (isNothingToSend) {
      // 프로브(단건 시험 발송) 토큰을 획득했으나 발송 대상이 없는 경우 즉시 반환하여 다른 워커가 프로브를 수행할 수 있게 한다.
      if (grant.isProbe) await this.releaseProbe();

      return 'idle';
    }

    // 프로브 발송 시에는 획득 토큰이 1개이므로 점유 건도 1건이다.
    for (const delivery of claimed) {
      this.track(this.sendOne(delivery, leaseDeadline, grant.isProbe));
    }

    // 버킷 토큰이 소진된 경우 다음 토큰 보충 시각까지 대기하여 불필요한 DB 행 경합을 방지한다 (ADR-0009).
    const isBucketDrained = grant.waitMs > 0;

    return isBucketDrained ? { sleepMs: grant.waitMs } : 'busy';
  }

  /**
   * 일시 정지(429·브레이커) 또는 프로브 대기 상태면 해당 시각까지 대기한다 (최대 IDLE_POLL_MS 단위로 재확인).
   * 다중 워커 경합으로 토큰을 획득하지 못한 경우 연속 실패 횟수에 따라 지수 백오프를 적용한다 (ADR-0009).
   */
  private waitForTokens(waitMs: number): number {
    const isPausedLonger = waitMs > TOKEN_WAIT_MAX_MS;
    if (isPausedLonger) return Math.min(waitMs, this.deps.config.IDLE_POLL_MS);
    this.emptyGrants += 1;

    return tokenRetryWaitMs(this.emptyGrants, waitMs);
  }

  /** 개별 발송 비동기 작업을 추적하며, 예기치 않은 예외가 루프나 다른 작업으로 전파되지 않도록 격리한다. */
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

  private sendOne(
    delivery: ClaimedDelivery,
    leaseDeadline: number,
    isProbe: boolean,
  ): Promise<void> {
    return withLogContext(
      {
        alarmId: delivery.alarmId,
        deliveryId: String(delivery.id),
        attempt: delivery.attempts,
      },
      () => this.sendInContext(delivery, leaseDeadline, isProbe),
    );
  }

  private async sendInContext(
    delivery: ClaimedDelivery,
    leaseDeadline: number,
    isProbe: boolean,
  ): Promise<void> {
    const { config, deliveries, client, metrics, logger, bucket, breaker } =
      this.deps;
    const canSend = () =>
      hasLeaseFor(leaseDeadline, monotonicMs(), config.SEND_TIMEOUT_MS);

    // 정상 종료(graceful shutdown) 중 점유된 건은 발송하지 않고 즉시 반납한다 (ADR-0007).
    // 잔여 리스 검증(canSend)은 소켓 쓰기 직전에 수행한다 (ADR-0004).
    const isShuttingDown = this.loop.isStopping;
    if (isShuttingDown) {
      await this.giveBack(delivery, isProbe);

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
      canSend,
    );
    const priority = String(delivery.priority);

    metrics.sendRequests.inc({ priority, result: result.kind });
    metrics.sendDuration.observe(
      { priority },
      (monotonicMs() - startedAt) / 1000,
    );

    // 소켓 쓰기 직전 리스 검증 실패로 발송을 보류한 경우, 브레이커 집계에서 제외하고 시도 횟수를 차감해 반납한다 (ADR-0004, 0014).
    const isWithheld = result.kind === 'withheld';
    if (isWithheld) {
      await this.giveBack(delivery, isProbe);

      return;
    }

    const isRateLimited = result.kind === 'rate_limited';
    if (isRateLimited) {
      metrics.rateLimitPauses.inc();
      logger.warn('Got 429, pausing all workers', {
        retryAfterSec: result.retryAfterSec,
      });
      // 일시 정지 갱신이 실패하더라도 현재 건의 발송 결과 기록은 진행한다.
      await bucket
        .pauseFor(result.retryAfterSec * 1000)
        .catch((e: unknown) =>
          logger.error('Could not record the pause', e as Error),
        );
    }

    await breaker
      .record(result, startedAt, isProbe)
      .catch((e: unknown) =>
        logger.error('Could not record the circuit breaker result', e as Error),
      );

    // 서킷 브레이커 OPEN 구간의 실패는 외부 장애로 간주하여 시도 횟수(attempts)에서 차감한다 (ADR-0014).
    const decision = decideAfterSend(
      result,
      delivery.attempts,
      retryOptions(config),
      Math.random,
      breaker.isOpen(),
    );

    this.logDecision(delivery, result, decision);

    const outcome = await durable(() =>
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
   * 결과 기록이 펜싱 조건(owner/attempts) 불일치로 거부된 경우(리스 만료 회수 발생),
   * clientRef로 외부 발송 내역을 조회해 실제 중복 발송 여부를 확인하고 기록한다 (ADR-0004).
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
      await durable(() => deliveries.markDuplicate(delivery.id));
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

    // debug 레벨에서는 요청 상세 정보를 기록하며 본문은 로거에서 마스킹한다 (ADR-0028).
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

  /** 미전송 건을 반납하며, 프로브 토큰으로 점유한 경우 프로브 슬롯도 함께 반환한다. */
  private async giveBack(
    delivery: ClaimedDelivery,
    isProbe: boolean,
  ): Promise<void> {
    if (isProbe) await this.releaseProbe();
    await durable(() => this.deps.deliveries.releaseUnsent(delivery));
  }

  /** 프로브 슬롯 반환 실패 시에도 probe_until 만료 후 다음 프로브가 가능하므로 오류만 로깅한다. */
  private releaseProbe(): Promise<void> {
    return this.deps.bucket
      .releaseProbe()
      .catch((e: unknown) =>
        this.deps.logger.error('Could not release the probe token', e as Error),
      );
  }
}
