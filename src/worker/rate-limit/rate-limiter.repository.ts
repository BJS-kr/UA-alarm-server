import { eq, sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNowPlus } from '../../shared/db/db-clock';
import { Tx } from '../../shared/db/executor';
import { rateLimiter } from '../../shared/db/schema';

/** 토큰 버킷 행은 하나뿐이다 (ADR-0009). */
const SINGLE_ROW = 1;

export interface AcquireResult {
  granted: number;
  /** 다음 토큰 보충 또는 일시 정지·프로브 대기 해제까지 남은 시간(ms). 잔여 토큰이 있으면 0 */
  waitMs: number;
  /** 서킷 브레이커 OPEN 후 허용된 프로브(단건 시험 발송) 토큰 여부 */
  isProbe: boolean;
  /** 서킷 브레이커 OPEN 여부. OPEN 구간의 실패는 발송 시도 횟수에서 차감한다. */
  isBreakerOpen: boolean;
}

export interface BreakerState {
  isPaused: boolean;
  /** 직전 브레이커 정지 해제 시각으로부터 streakWindowMs 이내인지 여부 */
  isConsecutive: boolean;
  streak: number;
}

/** 다중 워커 공유 토큰 버킷 저장소 (ADR-0009, 0014). 기준 시계는 PostgreSQL clock_timestamp()로 통일한다. */
export class RateLimiterRepository {
  constructor(private readonly db: Db) {}

  /**
   * 요청 시점에 경과 시간만큼 토큰을 보충(lazy refill)하고 차감한다.
   * 보충 계산과 차감을 단일 UPDATE CTE 문으로 처리하여 동시 요청 간 중복 지급을 방지한다.
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
               -- 일시 정지 중이면 0. 브레이커 OPEN 상태면 프로브 1건만 허용하며, 이미 프로브 진행 중이면 0 (ADR-0014).
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
                     -- 차감 후 잔여 토큰이 1개 미만이면 다음 토큰 보충까지 남은 시간(ms), 1개 이상이면 0.
                     ELSE GREATEST(0, 1 - (p.avail - p.granted)) / ${ratePerSec}::float8 * 1000 END AS wait_ms`);
    const row = result.rows[0];

    return {
      granted: Number(row?.granted ?? 0),
      waitMs: Math.ceil(Number(row?.wait_ms ?? 0)),
      isProbe: row?.is_probe === true,
      isBreakerOpen: row?.breaker_open === true,
    };
  }

  /** 프로브 발송 성공 시 서킷 브레이커를 CLOSED로 복귀시킨다 (ADR-0014). */
  async closeBreaker(): Promise<void> {
    await this.db
      .update(rateLimiter)
      .set({ breakerOpen: false, probeUntil: sql`'-infinity'` })
      .where(eq(rateLimiter.id, SINGLE_ROW));
  }

  /** 획득한 프로브 토큰을 사용하지 않은 경우(발송 대상 없음 등) 즉시 반환하여 다음 프로브를 허용한다. */
  async releaseProbe(): Promise<void> {
    await this.db
      .update(rateLimiter)
      .set({ probeUntil: sql`'-infinity'` })
      .where(eq(rateLimiter.id, SINGLE_ROW));
  }

  /** 일시 정지 해제 시각(paused_until)을 GREATEST(기존값, now + ms)로 갱신한다. */
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
