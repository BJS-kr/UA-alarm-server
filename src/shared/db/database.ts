import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema';

// int8을 number로 받는다. ID, 순번, 건수, 워커 ID가 모두 2^53 미만이다.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

/**
 * application_name은 무효 선언(ADR-0004)이 워커의 세션을 찾는 데 쓰므로 반드시 붙인다.
 * 서버 쪽에서 연결이 끊기면(DB 재시작, 무효 선언) 그 연결이 'error'를 낸다. 풀은 쉬고 있는 연결의 오류만 받아 주고,
 * 빌려 간 연결(트랜잭션의 쿼리와 쿼리 사이 등)의 오류는 받지 않는다. 리스너가 없으면 처리되지 않은 오류로 프로세스가
 * 죽으므로 모든 연결에 리스너를 단다. 끊긴 연결로 보낸 다음 쿼리는 실패하므로 그 처리는 쿼리를 부른 쪽이 한다.
 */
export function createPool(
  connectionString: string,
  applicationName: string,
  max: number,
  onConnectionError: (error: Error) => void = () => undefined,
): Pool {
  const pool = new Pool({ connectionString, application_name: applicationName, max });
  pool.on('connect', (client) => client.on('error', onConnectionError));
  // 쉬던 연결의 오류는 위 리스너가 이미 받았다. 풀이 같은 오류를 다시 내는 'error'는 받을 곳이 없으면 던져지므로 받기만 한다.
  pool.on('error', () => undefined);
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
