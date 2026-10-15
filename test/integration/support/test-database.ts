import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { createDb, Db } from '../../../src/shared/db/database';

/**
 * 테스트 파일마다 실제 PostgreSQL에 새 DB를 만들고 마이그레이션을 적용한다 (ADR-0035).
 * advisory lock과 pg_stat_activity는 DB 단위로 걸러 쓰므로 테스트끼리 섞이지 않는다.
 */
export interface TestDatabase {
  url: string;
  pool: Pool;
  db: Db;
  drop: () => Promise<void>;
}

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgres://postgres:postgres_pw@localhost:5432/postgres';

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });

  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = withDatabase(ADMIN_URL, name);

  const migrator = new Pool({ connectionString: url, max: 1 });

  await migrate(drizzle(migrator), {
    migrationsFolder: path.join(__dirname, '..', '..', '..', 'drizzle'),
  });
  await migrator.end();

  const pool = new Pool({
    connectionString: url,
    max: 10,
    application_name: 'alarm-test',
  });

  // DB를 지울 때 쉬던 연결이 끊기며 나는 오류는 무시한다.
  pool.on('error', () => undefined);

  return {
    url,
    pool,
    db: createDb(pool),
    drop: async () => {
      // 앱 종료 훅이 이미 pool을 닫았을 수 있다.
      await pool.end().catch(() => undefined);

      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);

  parsed.pathname = `/${database}`;

  return parsed.toString();
}
