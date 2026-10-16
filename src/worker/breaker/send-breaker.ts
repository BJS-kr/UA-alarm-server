import { LoggerService } from '@nestjs/common';
import { BreakerWindow } from '../../shared/domain/breaker-window';
import { isBreakerFailure, SendResult } from '../../shared/domain/send-outcome';
import { monotonicMs } from '../runtime/loop-utils';
import { BreakerOptions, TokenBucket } from '../rate-limit/token-bucket';

/**
 * 발송 장애 감지 및 서킷 브레이커 제어 (ADR-0014). 외부 /health 엔드포인트가 아닌 실제 발송 결과를 기준으로 판단한다.
 * - 장애율 임계치 초과 시 브레이커를 OPEN으로 전이하고 DB 토큰 버킷의 paused_until을 갱신해 전체 워커를 일시 정지시킨다.
 * - 정지 해제 후에는 전체 워커를 통틀어 프로브(단건 시험 발송) 1건만 허용한다. 성공 시 CLOSED로 복귀하고 실패 시 정지 시간을 배수로 늘린다.
 * - 브레이커 OPEN 이전에 시작되어 뒤늦게 도착한 요청 결과는 슬라이딩 윈도우 집계에서 제외한다.
 */
export class SendBreaker {
  private readonly window: BreakerWindow;
  private isOpenNow = false;
  /** 현재 워커가 브레이커 OPEN을 인지한 단조 시계 시각(ms). 이 시각 이전에 시작된 요청의 결과는 집계에서 제외한다. */
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

  /** 서킷 브레이커 OPEN 여부. OPEN 구간의 실패는 발송 시도 횟수(attempts)에서 차감한다 (ADR-0014). */
  isOpen(): boolean {
    return this.isOpenNow;
  }

  /** 토큰 획득 시 DB에서 읽은 브레이커 OPEN 상태를 동기화한다. */
  observe(isBreakerOpen: boolean): void {
    const isNewlyOpened = isBreakerOpen && !this.isOpenNow;
    if (isNewlyOpened) this.markOpened();
    const isNewlyClosed = !isBreakerOpen && this.isOpenNow;
    if (isNewlyClosed) this.markClosed();
  }

  /** startedAt은 해당 발송 요청이 시작된 단조 시계 시각(ms)이다. */
  async record(
    result: SendResult,
    startedAt: number,
    isProbe: boolean,
  ): Promise<void> {
    const isFailure = isBreakerFailure(result);
    if (isProbe) return this.recordProbe(isFailure);
    const isStartedBeforeOpening = startedAt <= this.openedAt;
    if (isStartedBeforeOpening) return;
    const isOutage = this.window.record(isFailure, startedAt);
    if (isOutage) await this.trip('Send failures look like an outage');
  }

  private async recordProbe(isFailure: boolean): Promise<void> {
    if (isFailure) {
      this.onProbe('still_failing');
      const isReopened = await this.trip(
        'The probe send failed, the outage continues',
      );
      // 429 일시 정지 중이어서 재개방하지 못한 경우, 정지 해제 직후 프로브를 재시도할 수 있도록 프로브 슬롯을 반환한다.
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
