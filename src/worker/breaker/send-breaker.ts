import { LoggerService } from '@nestjs/common';
import { BreakerWindow } from '../../shared/domain/breaker-window';
import { isBreakerFailure, SendResult } from '../../shared/domain/send-outcome';
import { BreakerOptions, TokenBucket } from '../rate-limit/token-bucket';

/**
 * 발송 장애 시 전체 정지 (ADR-0014). 판단은 외부 서비스의 health가 아니라 발송 결과로 한다.
 * 장애로 판단하면 토큰 버킷의 정지 칸을 미뤄 모든 워커가 함께 멈추고, 풀린 뒤의 발송 결과로 다시 판단한다.
 */
export class SendBreaker {
  private readonly window: BreakerWindow;

  constructor(
    size: number,
    failureRatio: number,
    private readonly bucket: TokenBucket,
    private readonly options: BreakerOptions,
    private readonly logger: LoggerService,
    private readonly onTrip: () => void,
  ) {
    this.window = new BreakerWindow(size, failureRatio);
  }

  async record(result: SendResult): Promise<void> {
    if (!this.window.record(isBreakerFailure(result))) return;
    const trip = await this.bucket.tripBreaker(this.options);
    if (trip.tripped) {
      this.onTrip();
      this.logger.error('발송 장애로 판단해 전체 발송을 멈춘다', { pauseMs: trip.pauseMs, streak: trip.streak });
    }
  }
}
