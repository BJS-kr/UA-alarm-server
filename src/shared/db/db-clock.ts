import { sql, SQL } from 'drizzle-orm';

/**
 * 시각은 모두 DB 시계로 잰다 (ADR-0009, 0029). 워커마다 시계가 어긋나도 판단이 한 시계로 모인다.
 * 빌더의 값 자리에 그대로 넣는 식이다.
 */
export const dbNow: SQL = sql`clock_timestamp()`;

/** DB 시계 기준 ms 뒤. */
export function dbNowPlus(ms: number): SQL {
  return sql`clock_timestamp() + make_interval(secs => ${ms / 1000})`;
}
