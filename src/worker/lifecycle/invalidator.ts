import { sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';

/**
 * 무효 선언 (ADR-0004). 잠금 연결이 일정 시간 넘게 조용한 워커를 찾아,
 * 그 워커 ID가 붙은 모든 세션(잠금 연결과 커넥션 풀)을 끊는다.
 * 잠금 연결만 끊으면 같은 워커의 풀 연결이 살아남아 무효 뒤에도 쓰기가 들어갈 수 있기 때문이다.
 * 판단은 DB 시계 하나로 한다. 여러 워커가 동시에 끊어도 무해하다.
 */
export async function invalidateSilentWorkers(db: Db, selfId: number, silentForMs: number): Promise<number> {
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
