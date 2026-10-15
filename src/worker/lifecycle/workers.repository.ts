import { sql, SQL, SQLWrapper } from 'drizzle-orm';
import { Db } from '../../shared/db/database';

/**
 * 살아 있는 워커 명단과 무효 선언 (ADR-0004). 등록 테이블은 없고, 명단은 pg_locks에 잡힌 advisory lock 그 자체다.
 * pg_locks와 pg_stat_activity는 스키마에 없는 시스템 카탈로그라 빌더 대신 SQL로 쓴다.
 *
 * pg_advisory_lock(bigint)의 키는 pg_locks에 classid(상위 32비트), objid(하위 32비트), objsubid = 1로 나타난다.
 */
const aliveWorkerIds: SQL = sql`
  SELECT (l.classid::bigint << 32) | l.objid::bigint AS worker_id
    FROM pg_locks l
   WHERE l.locktype = 'advisory'
     AND l.objsubid = 1
     AND l.granted
     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

/** owner 컬럼의 워커가 명단에 없으면 참인 조건식. 넘겨받기와 작업 점유가 빌더의 where에 넣어 쓴다. */
export function ownerIsGone(ownerColumn: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM (${aliveWorkerIds}) alive WHERE alive.worker_id = ${ownerColumn})`;
}

/**
 * 잠금 연결이 silentForMs 넘게 조용한 워커를 찾아, 그 워커의 모든 세션을 끊는다.
 * 잠금 연결만 끊으면 같은 워커의 풀 연결이 살아남아 무효 뒤에도 쓰기가 들어가거나 알림 행 잠금이 풀리지 않는다.
 * 판단은 DB 시계 하나로 한다. 끊은 세션 수를 돌려준다.
 */
export async function invalidateSilentWorkers(
  db: Db,
  selfId: number,
  silentForMs: number,
): Promise<number> {
  const result = await db.execute<{ terminated: boolean }>(sql`
    WITH silent AS (
      SELECT split_part(application_name, ':', 2) AS worker_id
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name LIKE 'alarm-worker:%:lock'
         AND state_change < clock_timestamp() - make_interval(secs => ${silentForMs / 1000})
         AND split_part(application_name, ':', 2) <> ${String(selfId)}
    )
    SELECT pg_terminate_backend(a.pid) AS terminated
      FROM pg_stat_activity a
      JOIN silent s ON split_part(a.application_name, ':', 2) = s.worker_id
     WHERE a.datname = current_database()
       AND a.application_name LIKE 'alarm-worker:%'`);

  return result.rows.filter((row) => row.terminated).length;
}
