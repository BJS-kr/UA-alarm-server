import { sql, SQL } from 'drizzle-orm';

/**
 * 살아 있는 워커 명단은 pg_locks에 잡힌 advisory lock 그 자체다 (ADR-0004). 등록 테이블은 없다.
 * pg_advisory_lock(bigint)의 키는 pg_locks에 classid(상위 32비트), objid(하위 32비트), objsubid = 1로 나타난다.
 */
export const aliveWorkerIds: SQL = sql`
  SELECT (l.classid::bigint << 32) | l.objid::bigint AS worker_id
    FROM pg_locks l
   WHERE l.locktype = 'advisory'
     AND l.objsubid = 1
     AND l.granted
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

/** owner 컬럼의 워커가 명단에 없으면 true인 조건식. */
export function ownerIsGone(ownerColumn: SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM (${aliveWorkerIds}) alive WHERE alive.worker_id = ${ownerColumn})`;
}
