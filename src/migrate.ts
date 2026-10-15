import 'reflect-metadata';
import * as path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from './shared/config/app-config';
import { createDb, createPool } from './shared/db/database';
import { waitForDatabase } from './shared/db/wait-for-database';
import { AppLogger } from './shared/logging/app-logger';

/** 마이그레이션 계정으로 스키마를 적용하고 끝난다 (ADR-0025, 0036). */
async function main(): Promise<void> {
  const config = loadConfig(process.env, 'migrate');
  const logger = new AppLogger(config.LOG_LEVEL, 'Migrate');
  const pool = createPool(config.MIGRATION_DATABASE_URL!, 'alarm-migrate', 1);
  try {
    await waitForDatabase(pool, logger);
    await migrate(createDb(pool), { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
    logger.log('마이그레이션 완료');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // 로거를 만들기 전에 실패할 수 있으므로 표준 에러로 직접 남긴다.
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: (error as Error).message })}\n`);
  process.exit(1);
});
