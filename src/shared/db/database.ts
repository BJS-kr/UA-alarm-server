import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema';

// int8을 number로 받는다. ID, 순번, 건수, 워커 ID가 모두 2^53 미만이다.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

/**
 * application_name은 pg_stat_activity에서 어느 프로세스의 연결인지 알아보는 데 쓴다.
 * 서버 쪽에서 연결이 끊기면(DB 재시작, 트랜잭션 유휴 한도 초과) 그 연결이 'error'를 낸다. 풀은 쉬고 있는 연결의 오류만 받아 주고,
 * 빌려 간 연결(트랜잭션의 쿼리와 쿼리 사이 등)의 오류는 받지 않는다. 리스너가 없으면 처리되지 않은 오류로 프로세스가
 * 죽으므로 모든 연결에 리스너를 단다. 끊긴 연결로 보낸 다음 쿼리는 실패하므로 그 처리는 쿼리를 부른 쪽이 한다.
 */
export interface PoolTimeouts {
  /** 풀에서 연결을 얻기까지 기다리는 최대 시간 */
  acquireMs: number;
  /** 쿼리 하나의 응답을 기다리는 최대 시간. 클라이언트 쪽에서 잰다. */
  queryMs: number;
}

/**
 * timeouts를 주면 연결을 얻거나 쿼리 응답을 기다리다 끝없이 멈추지 않는다. api는 요청마다 반드시 응답해야 하므로 준다 (ADR-0039).
 * worker는 주지 않는다. 멈춘 워커가 쥔 알림 행 잠금이 풀리기를 기다리는 것이 정상이라, 시간 제한에 걸리면 멀쩡한 워커의 결과 기록이 실패한다.
 *
 * idleInTransactionMs는 서버 쪽 한도다. 트랜잭션 도중 클라이언트가 그 시간 넘게 다음 쿼리를 보내지 않으면
 * Postgres가 세션을 끝내고 잠금을 푼다. 트랜잭션 도중 멈춘 프로세스가 행 잠금을 쥐고 남지 않게 한다 (ADR-0004).
 */
export function createPool(
  connectionString: string,
  applicationName: string,
  max: number,
  onConnectionError: (error: Error) => void = () => undefined,
  timeouts?: PoolTimeouts,
  idleInTransactionMs?: number,
): Pool {
  const pool = new Pool({
    connectionString,
    application_name: applicationName,
    max,
    connectionTimeoutMillis: timeouts?.acquireMs,
    query_timeout: timeouts?.queryMs,
    idle_in_transaction_session_timeout: idleInTransactionMs,
  });

  pool.on('connect', (client) => client.on('error', onConnectionError));
  // 쉬던 연결의 오류는 위 리스너가 이미 받았다. 풀이 같은 오류를 다시 내는 'error'는 받을 곳이 없으면 던져지므로 받기만 한다.
  pool.on('error', () => undefined);

  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
