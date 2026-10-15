import { eq, sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNowPlus } from '../../shared/db/db-clock';
import { Tx } from '../../shared/db/executor';
import { rateLimiter } from '../../shared/db/schema';

/** 토큰 버킷 행은 하나뿐이다 (ADR-0009). */
const SINGLE_ROW = 1;

export interface BreakerState {
  isPaused: boolean;
  /** 직전 브레이커 정지가 풀린 뒤 streakWindowMs 안인가 */
  isConsecutive: boolean;
  streak: number;
}

/** 모든 워커가 함께 쓰는 토큰 버킷 행의 저장소 (ADR-0009, 0014). 시계는 DB 시계 하나다. */
export class RateLimiterRepository {
  constructor(private readonly db: Db) {}

  /**
   * 요청할 때 흐른 시간만큼 채우고(lazy refill) 지급한다. 계산과 지급이 한 문장이어야 같은 토큰이 두 번 나가지 않아,
   * 중간값을 CTE로 이어 붙인 SQL로 쓴다. 잠금을 기다리는 동안 다른 워커가 refilled_at을 앞으로 옮겼을 수 있으므로,
   * 흐른 시간은 0 아래로 내려가지 않게, refilled_at은 뒤로 가지 않게 막아 더 지급하는 일이 없게 한다.
   */
  async acquire(
    requested: number,
    ratePerSec: number,
    capacity: number,
  ): Promise<{ granted: number; waitMs: number }> {
    const result = await this.db.execute<{
      granted: number;
      wait_ms: number;
    }>(sql`
      WITH cur AS (
        SELECT r.tokens, r.refilled_at, r.paused_until, clock_timestamp() AS ts
          FROM rate_limiter r
         WHERE r.id = ${SINGLE_ROW}
           FOR UPDATE
      ),
      calc AS (
        SELECT ts, paused_until, GREATEST(refilled_at, ts) AS new_refilled_at,
               LEAST(${capacity}::float8,
                     tokens + GREATEST(0, EXTRACT(EPOCH FROM ts - refilled_at)::float8) * ${ratePerSec}::float8) AS avail
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
       WHERE r.id = ${SINGLE_ROW}
      RETURNING g.granted,
                CASE WHEN g.ts < g.paused_until THEN EXTRACT(EPOCH FROM g.paused_until - g.ts)::float8 * 1000
                     WHEN g.granted = 0 THEN GREATEST(0, 1 - g.avail) / ${ratePerSec}::float8 * 1000
                     ELSE 0 END AS wait_ms`);
    const row = result.rows[0];

    return {
      granted: Number(row?.granted ?? 0),
      waitMs: Math.ceil(Number(row?.wait_ms ?? 0)),
    };
  }

  /** 정지 해제 시각을 지금 + ms 이후로 미룬다. 이미 더 늦게 잡혀 있으면 그대로 둔다. */
  async extendPause(ms: number): Promise<void> {
    await this.db
      .update(rateLimiter)
      .set({
        pausedUntil: sql`GREATEST(${rateLimiter.pausedUntil}, ${dbNowPlus(ms)})`,
      })
      .where(eq(rateLimiter.id, SINGLE_ROW));
  }

  inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /** 브레이커 상태를 행 잠금과 함께 읽는다. 여러 워커가 동시에 발동하려 해도 하나씩 판단한다. */
  async lockBreakerState(
    tx: Tx,
    streakWindowMs: number,
  ): Promise<BreakerState | undefined> {
    const [state] = await tx
      .select({
        isPaused: sql<boolean>`${rateLimiter.pausedUntil} > clock_timestamp()`,
        isConsecutive: sql<boolean>`${rateLimiter.breakerLastUntil} > clock_timestamp() - make_interval(secs => ${streakWindowMs / 1000})`,
        streak: rateLimiter.breakerStreak,
      })
      .from(rateLimiter)
      .where(eq(rateLimiter.id, SINGLE_ROW))
      .for('update');

    return state;
  }

  async saveBreakerTrip(
    tx: Tx,
    streak: number,
    pauseMs: number,
  ): Promise<void> {
    await tx
      .update(rateLimiter)
      .set({
        breakerStreak: streak,
        pausedUntil: dbNowPlus(pauseMs),
        breakerLastUntil: dbNowPlus(pauseMs),
      })
      .where(eq(rateLimiter.id, SINGLE_ROW));
  }
}
