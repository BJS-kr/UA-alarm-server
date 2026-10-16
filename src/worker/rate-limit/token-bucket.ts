import { Db } from '../../shared/db/database';
import { breakerPauseMs } from '../../shared/domain/retry-policy';
import {
  AcquireResult,
  RateLimiterRepository,
} from './rate-limiter.repository';

export interface BreakerOptions {
  pauseMinMs: number;
  pauseMaxMs: number;
  streakWindowMs: number;
}

/** 연달아 발동한 횟수의 상한. 정지 시간은 어차피 pauseMaxMs에서 멈춘다. */
const MAX_STREAK = 10;

/**
 * 다중 워커 공유 토큰 버킷 (ADR-0009). PostgreSQL 단일 행(rate_limiter)에 상태를 유지하며
 * 별도 보충 타이머 없이 요청 시점의 경과 시간으로 토큰을 계산한다(lazy refill).
 */
export class TokenBucket {
  private readonly repository: RateLimiterRepository;

  /** probeLeaseMs: 프로브 발송을 점유한 워커가 중단되었을 때 다른 워커가 다음 프로브를 시도하기까지의 리스 시간(ms) */
  constructor(
    db: Db,
    private readonly ratePerSec: number,
    private readonly capacity: number,
    private readonly probeLeaseMs: number,
  ) {
    this.repository = new RateLimiterRepository(db);
  }

  acquire(requested: number): Promise<AcquireResult> {
    return this.repository.acquire(
      requested,
      this.ratePerSec,
      this.capacity,
      this.probeLeaseMs,
    );
  }

  /** 프로브 발송 성공 시 서킷 브레이커를 CLOSED로 전이한다 (ADR-0014). */
  closeBreaker(): Promise<void> {
    return this.repository.closeBreaker();
  }

  /** 미사용 프로브 토큰을 반환한다. */
  releaseProbe(): Promise<void> {
    return this.repository.releaseProbe();
  }

  /** 429 응답 수신 시 paused_until을 갱신해 전체 워커의 발송을 일시 정지한다. */
  pauseFor(ms: number): Promise<void> {
    return this.repository.extendPause(ms);
  }

  /**
   * 서킷 브레이커 OPEN 전이 및 일시 정지 설정 (ADR-0014). 이미 정지 중이면 중복 발동하지 않는다.
   * 프로브 발송 실패 시에도 동일 경로로 재개방하며, 직전 정지 해제 후 streakWindowMs 이내 재발동 시 streak을 증가시킨다.
   */
  tripBreaker(
    options: BreakerOptions,
  ): Promise<{ tripped: boolean; pauseMs: number; streak: number }> {
    return this.repository.inTransaction(async (tx) => {
      const state = await this.repository.lockBreakerState(
        tx,
        options.streakWindowMs,
      );
      const isRowMissing = state === undefined;
      if (isRowMissing) return { tripped: false, pauseMs: 0, streak: 0 };

      if (state.isPaused) {
        return { tripped: false, pauseMs: 0, streak: state.streak };
      }

      const streak = state.isConsecutive
        ? Math.min(state.streak + 1, MAX_STREAK)
        : 0;
      const pauseMs = breakerPauseMs(
        streak,
        options.pauseMinMs,
        options.pauseMaxMs,
      );

      await this.repository.saveBreakerTrip(tx, streak, pauseMs);

      return { tripped: true, pauseMs, streak };
    });
  }
}
