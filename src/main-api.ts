import 'reflect-metadata';
import { createApiApp } from './api/create-api-app';
import { createApiRegistry } from './api/metrics/api-metrics';
import { describeConfig, loadConfig } from './shared/config/app-config';
import { createDb, createPool } from './shared/db/database';
import { pingDatabase } from './shared/db/ping';
import { waitForDatabase } from './shared/db/wait-for-database';
import { ManagementServer } from './shared/health/management-server';
import { AppLogger } from './shared/logging/app-logger';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env, 'api');
  const logger = new AppLogger(config.LOG_LEVEL, 'Api');
  // 실제 적용된 설정값을 한 번 남긴다. 비밀값은 가린다 (ADR-0030).
  logger.log('설정 적용', describeConfig(config));

  const pool = createPool(config.DATABASE_URL!, 'alarm-api', 10, (error) =>
    logger.warn('DB 연결이 끊겼다', { error: error.message }),
  );
  await waitForDatabase(pool, logger);

  const app = await createApiApp(config, pool, logger);
  app.enableShutdownHooks();
  await app.listen(config.PORT);

  // 생존 확인에는 DB를 넣지 않는다. DB 상태는 준비 확인에만 넣는다 (ADR-0026).
  const management = new ManagementServer(config.MANAGEMENT_PORT, {
    live: () => true,
    ready: () => pingDatabase(pool, 1_000),
    registry: createApiRegistry(createDb(pool)),
  });
  await management.start();
  process.once('SIGTERM', () => void management.stop());
  logger.log('api 시작', { port: config.PORT, managementPort: config.MANAGEMENT_PORT });
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: (error as Error).message, stack: (error as Error).stack })}\n`);
  process.exit(1);
});
