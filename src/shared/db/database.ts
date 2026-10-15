import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, types } from 'pg';
import * as schema from './schema';

// int8을 number로 받는다. ID, 순번, 건수, 워커 ID가 모두 2^53 미만이다.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export type Db = NodePgDatabase<typeof schema>;
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

/** application_name은 무효 선언(ADR-0004)이 워커의 세션을 찾는 데 쓰므로 반드시 붙인다. */
export function createPool(connectionString: string, applicationName: string, max: number): Pool {
  return new Pool({ connectionString, application_name: applicationName, max });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
