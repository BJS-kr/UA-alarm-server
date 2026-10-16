import { eq, sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNowPlus } from '../../shared/db/db-clock';
import { Tx } from '../../shared/db/executor';
import { rateLimiter } from '../../shared/db/schema';

/** 토큰 버킷 행은 하나뿐이다 (ADR-0009). */
const SINGLE_ROW = 1;

export interface AcquireResult {
  granted: number;
  /** 다음 토큰이 생기거나 정지·시험 발송이 끝나기까지 남은 시간. 받고도 통에 토큰이 남았으면 0이다 */
  waitMs: number;
  /** 이 토큰이 브레이커가 열린 뒤의 시험 발송이다. 결과를 반드시 알려야 한다. */
  isProbe: boolean;
  /** 브레이커가 열려 있다(장애로 판단한 상태). 이 동안의 실패는 시도 횟수에 세지 않는다. */
  isBreakerOpen: boolean;
}

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
    probeLeaseMs: number,
  ): Promise<AcquireResult> {
    const result = await this.db.execute<{
      granted: number;
      wait_ms: number;
      is_probe: boolean;
      breaker_open: boolean;
    }>(sql`
      WITH cur AS (
        SELECT r.tokens, r.refilled_at, r.paused_until, r.breaker_open, r.probe_until, clock_timestamp() AS ts
          FROM rate_limiter r
         WHERE r.id = ${SINGLE_ROW}
           FOR UPDATE
      ),
      calc AS (
        SELECT ts, paused_until, breaker_open, probe_until, GREATEST(refilled_at, ts) AS new_refilled_at,
               LEAST(${capacity}::float8,
                     tokens + GREATEST(0, EXTRACT(EPOCH FROM ts - refilled_at)::float8) * ${ratePerSec}::float8) AS avail
          FROM cur
      ),
      g AS (
        SELECT ts, avail, paused_until, breaker_open, probe_until, new_refilled_at,
               -- 정지 중이면 0. 브레이커가 열려 있으면 시험 발송 한 건만, 이미 나가 있으면 0 (ADR-0014).
               CASE WHEN ts < paused_until THEN 0
                    WHEN breaker_open AND ts < probe_until THEN 0
                    WHEN breaker_open THEN LEAST(1, floor(avail)::int)
                    ELSE LEAST(${requested}::int, floor(avail)::int) END AS granted
          FROM calc
      ),
      p AS (
        SELECT g.*, (g.breaker_open AND g.granted > 0) AS is_probe FROM g
      )
      UPDATE rate_limiter r
         SET tokens = p.avail - p.granted, refilled_at = p.new_refilled_at,
             probe_until = CASE WHEN p.is_probe THEN p.ts + make_interval(secs => ${probeLeaseMs / 1000}) ELSE r.probe_until END
        FROM p
       WHERE r.id = ${SINGLE_ROW}
      RETURNING p.granted, p.is_probe, p.breaker_open,
                CASE WHEN p.ts < p.paused_until THEN EXTRACT(EPOCH FROM p.paused_until - p.ts)::float8 * 1000
                     WHEN p.breaker_open AND p.ts < p.probe_until THEN EXTRACT(EPOCH FROM p.probe_until - p.ts)::float8 * 1000
                     -- 받은 뒤 통이 비었으면 다음 토큰까지 남은 시간이다. 남은 토큰이 1개 이상이면 0.
                     ELSE GREATEST(0, 1 - (p.avail - p.granted)) / ${ratePerSec}::float8 * 1000 END AS wait_ms`);
    const row = result.rows[0];

    return {
      granted: Number(row?.granted ?? 0),
      waitMs: Math.ceil(Number(row?.wait_ms ?? 0)),
      isProbe: row?.is_probe === true,
      isBreakerOpen: row?.breaker_open === true,
    };
  }

  /** 시험 발송이 성공했다. 브레이커를 닫아 평소처럼 토큰을 낸다 (ADR-0014). */
  async closeBreaker(): Promise<void> {
    await this.db
      .update(rateLimiter)
      .set({ breakerOpen: false, probeUntil: sql`'-infinity'` })
      .where(eq(rateLimiter.id, SINGLE_ROW));
  }

  /** 받은 시험 발송 토큰을 쓰지 않았다(보낼 건이 없었음 등). 다음 요청이 바로 다시 시험할 수 있게 한다. */
  async releaseProbe(): Promise<void> {
    await this.db
      .update(rateLimiter)
      .set({ probeUntil: sql`'-infinity'` })
      .where(eq(rateLimiter.id, SINGLE_ROW));
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
        breakerOpen: true,
        probeUntil: sql`'-infinity'`,
      })
      .where(eq(rateLimiter.id, SINGLE_ROW));
  }
}
