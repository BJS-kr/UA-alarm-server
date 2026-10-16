import { LoggerService } from '@nestjs/common';
import { BreakerWindow } from '../../shared/domain/breaker-window';
import { isBreakerFailure, SendResult } from '../../shared/domain/send-outcome';
import { monotonicMs } from '../runtime/loop-utils';
import { BreakerOptions, TokenBucket } from '../rate-limit/token-bucket';

/**
 * 발송 장애 시 전체 정지 (ADR-0014). 판단은 외부 서비스의 health가 아니라 발송 결과로 한다.
 * - 장애로 판단하면 브레이커를 열고 토큰 버킷의 정지 칸을 미뤄 모든 워커가 함께 멈춘다.
 * - 정지가 풀리면 모든 워커를 합쳐 시험 발송 한 건만 나간다. 성공하면 닫고, 실패하면 정지를 두 배로 늘려 다시 연다.
 * - 브레이커가 열린 뒤에 도착한, 열리기 전에 시작한 요청의 결과는 판단에 쓰지 않는다.
 *   정지 전에 나간 요청이 타임아웃으로 하나씩 돌아와 판단 창을 채우면, 풀리자마자 다시 발동하기 때문이다.
 * 열림 상태의 원본은 DB의 행 하나다. 워커는 토큰을 받을 때마다 그 상태를 받아 자기 판단에 반영한다.
 */
export class SendBreaker {
  private readonly window: BreakerWindow;
  private isOpenNow = false;
  /** 이 워커가 브레이커가 열린 것을 마지막으로 안 시각(단조 시계 ms). 그 전에 시작한 요청의 결과는 판단에 쓰지 않는다. */
  private openedAt = Number.NEGATIVE_INFINITY;

  constructor(
    size: number,
    failureRatio: number,
    private readonly bucket: TokenBucket,
    private readonly options: BreakerOptions,
    private readonly logger: LoggerService,
    private readonly onTrip: () => void,
    private readonly onProbe: (result: 'recovered' | 'still_failing') => void,
  ) {
    this.window = new BreakerWindow(size, failureRatio);
  }

  /** 장애로 판단한 상태인가. 이 동안의 실패는 시도 횟수에 세지 않는다 (ADR-0014). */
  isOpen(): boolean {
    return this.isOpenNow;
  }

  /** 토큰을 받을 때 DB가 알려 준 열림 상태를 반영한다. */
  observe(isBreakerOpen: boolean): void {
    const isNewlyOpened = isBreakerOpen && !this.isOpenNow;
    if (isNewlyOpened) this.markOpened();
    const isNewlyClosed = !isBreakerOpen && this.isOpenNow;
    if (isNewlyClosed) this.markClosed();
  }

  /** startedAt은 그 요청을 보내기 시작한 단조 시계 ms다. */
  async record(
    result: SendResult,
    startedAt: number,
    isProbe: boolean,
  ): Promise<void> {
    const isFailure = isBreakerFailure(result);
    if (isProbe) return this.recordProbe(isFailure);
    const isStartedBeforeOpening = startedAt <= this.openedAt;
    if (isStartedBeforeOpening) return;
    const isOutage = this.window.record(isFailure);
    if (isOutage) await this.trip('Send failures look like an outage');
  }

  private async recordProbe(isFailure: boolean): Promise<void> {
    if (isFailure) {
      this.onProbe('still_failing');
      const isReopened = await this.trip(
        'The probe send failed, the outage continues',
      );
      // 429 정지 중이라 다시 열지 못했다. 시험 토큰을 돌려줘야 정지가 풀리자마자 다시 시험한다.
      if (!isReopened) await this.bucket.releaseProbe();

      return;
    }

    this.onProbe('recovered');
    await this.bucket.closeBreaker();
    this.markClosed();
    this.logger.log('The probe send succeeded, resuming all sending');
  }

  /** 브레이커를 열었으면 true. 이미 정지 중이면 열지 않는다. */
  private async trip(reason: string): Promise<boolean> {
    const trip = await this.bucket.tripBreaker(this.options);
    const isTripped = trip.tripped;
    if (!isTripped) return false;
    this.markOpened();
    this.onTrip();
    this.logger.error(`${reason}, pausing all sending`, {
      pauseMs: trip.pauseMs,
      streak: trip.streak,
    });

    return true;
  }

  private markOpened(): void {
    this.isOpenNow = true;
    this.openedAt = monotonicMs();
  }

  private markClosed(): void {
    this.isOpenNow = false;
    this.window.reset();
  }
}
