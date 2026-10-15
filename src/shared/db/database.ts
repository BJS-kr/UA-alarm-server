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
 * 쉬고 있는 연결이 서버 쪽에서 끊기면(DB 재시작, 무효 선언) 풀이 'error'를 낸다. 리스너가 없으면
 * 처리되지 않은 오류로 프로세스가 죽으므로 반드시 받는다. 끊긴 연결은 풀이 스스로 버린다.
 */
export function createPool(
  connectionString: string,
  applicationName: string,
  max: number,
  onIdleError: (error: Error) => void = () => undefined,
): Pool {
  const pool = new Pool({ connectionString, application_name: applicationName, max });
  pool.on('error', onIdleError);
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
