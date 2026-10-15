import { Db } from '../../shared/db/database';
import { breakerPauseMs } from '../../shared/domain/retry-policy';
import { RateLimiterRepository } from './rate-limiter.repository';

export interface Grant {
  granted: number;
  /** 0개를 받았을 때 다음 토큰이 생기거나 정지가 풀리기까지 남은 시간 */
  waitMs: number;
}

export interface BreakerOptions {
  pauseMinMs: number;
  pauseMaxMs: number;
  streakWindowMs: number;
}

/** 연달아 발동한 횟수의 상한. 정지 시간은 어차피 pauseMaxMs에서 멈춘다. */
const MAX_STREAK = 10;

/**
 * 모든 워커가 함께 쓰는 토큰 버킷 (ADR-0009). 상태는 PG의 행 하나다.
 * 채우는 타이머가 없다. 요청할 때 흐른 시간만큼 계산해 채운다(lazy refill).
 */
export class TokenBucket {
  private readonly repository: RateLimiterRepository;

  constructor(
    db: Db,
    private readonly ratePerSec: number,
    private readonly capacity: number,
  ) {
    this.repository = new RateLimiterRepository(db);
  }

  acquire(requested: number): Promise<Grant> {
    return this.repository.acquire(requested, this.ratePerSec, this.capacity);
  }

  /** 429를 받으면 정지 해제 시각을 미뤄 모든 워커를 함께 멈춘다. */
  pauseFor(ms: number): Promise<void> {
    return this.repository.extendPause(ms);
  }

  /**
   * 서킷 브레이커 발동 (ADR-0014). 이미 정지 중이면 발동하지 않는다.
   * 여러 워커가 같은 장애를 동시에 감지해도 정지 시간이 겹쳐 두 배씩 늘지 않게 하기 위해서다.
   * 직전 브레이커 정지가 풀린 뒤 streakWindowMs 안에 다시 발동하면 연달아 발동한 것으로 보고 정지를 늘린다.
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
