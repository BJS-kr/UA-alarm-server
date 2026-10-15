import { sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { breakerPauseMs } from '../../shared/domain/retry-policy';

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

/**
 * 모든 워커가 함께 쓰는 토큰 버킷. PG의 행 하나다 (ADR-0009).
 * 채우는 타이머가 없다. 요청할 때 흐른 시간만큼 계산해 채운다(lazy refill).
 * 시계는 DB 시계(clock_timestamp) 하나이며, 행 잠금으로 같은 토큰이 두 번 지급되지 않는다.
 */
export class TokenBucket {
  constructor(
    private readonly db: Db,
    private readonly ratePerSec: number,
    private readonly capacity: number,
  ) {}

  async acquire(requested: number): Promise<Grant> {
    // 잠금을 기다리는 동안 다른 워커가 refilled_at을 앞으로 옮겼을 수 있다.
    // 흐른 시간은 0 아래로 내려가지 않게, refilled_at은 뒤로 가지 않게 막아 더 지급하는 일이 없게 한다.
    const result = await this.db.execute<{ granted: number; wait_ms: number }>(sql`
      WITH cur AS (
        SELECT r.tokens, r.refilled_at, r.paused_until, clock_timestamp() AS ts
          FROM rate_limiter r
         WHERE r.id = 1
           FOR UPDATE
      ),
      calc AS (
        SELECT ts, paused_until, GREATEST(refilled_at, ts) AS new_refilled_at,
               LEAST(${this.capacity}::float8,
                     tokens + GREATEST(0, EXTRACT(EPOCH FROM ts - refilled_at)::float8) * ${this.ratePerSec}::float8) AS avail
          FROM cur
      ),
      g AS (
        SELECT ts, avail, paused_until, new_refilled_at,
               CASE WHEN ts < paused_until THEN 0 ELSE LEAST(${requested}::int, floor(avail)::int) END AS granted
          FROM calc
      )
      UPDATE rate_limiter r
         SET tokens = g.avail - g.granted, refilled_at = g.new_refilled_at
        FROM g
       WHERE r.id = 1
      RETURNING g.granted,
                CASE WHEN g.ts < g.paused_until THEN EXTRACT(EPOCH FROM g.paused_until - g.ts)::float8 * 1000
                     WHEN g.granted = 0 THEN GREATEST(0, 1 - g.avail) / ${this.ratePerSec}::float8 * 1000
                     ELSE 0 END AS wait_ms`);
    const row = result.rows[0];
    return { granted: Number(row?.granted ?? 0), waitMs: Math.ceil(Number(row?.wait_ms ?? 0)) };
  }

  /** 429를 받으면 정지 해제 시각을 미뤄 모든 워커를 함께 멈춘다. */
  async pauseFor(ms: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE rate_limiter
         SET paused_until = GREATEST(paused_until, clock_timestamp() + make_interval(secs => ${ms / 1000}))
       WHERE id = 1`);
  }

  /**
   * 서킷 브레이커 발동 (ADR-0014). 이미 정지 중이면 발동하지 않는다.
   * 여러 워커가 같은 장애를 동시에 감지해도 정지 시간이 겹쳐 두 배씩 늘지 않게 하기 위해서다.
   * 직전 브레이커 정지가 풀린 뒤 streakWindowMs 안에 다시 발동하면 연달아 발동한 것으로 본다.
   */
  async tripBreaker(options: BreakerOptions): Promise<{ tripped: boolean; pauseMs: number; streak: number }> {
    return this.db.transaction(async (tx) => {
      const current = await tx.execute<{ paused: boolean; consecutive: boolean; streak: number }>(sql`
        SELECT paused_until > clock_timestamp() AS paused,
               breaker_last_until > clock_timestamp() - make_interval(secs => ${options.streakWindowMs / 1000}) AS consecutive,
               breaker_streak AS streak
          FROM rate_limiter WHERE id = 1
           FOR UPDATE`);
      const row = current.rows[0];
      if (!row || row.paused) return { tripped: false, pauseMs: 0, streak: row?.streak ?? 0 };
      const streak = row.consecutive ? Math.min(row.streak + 1, 10) : 0;
      const pauseMs = breakerPauseMs(streak, options.pauseMinMs, options.pauseMaxMs);
      await tx.execute(sql`
        UPDATE rate_limiter
           SET breaker_streak = ${streak},
               paused_until = clock_timestamp() + make_interval(secs => ${pauseMs / 1000}),
               breaker_last_until = clock_timestamp() + make_interval(secs => ${pauseMs / 1000})
         WHERE id = 1`);
      return { tripped: true, pauseMs, streak };
    });
  }
}
