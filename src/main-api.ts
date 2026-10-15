import 'reflect-metadata';
import { createApiApp } from './api/create-api-app';
import { createApiRegistry } from './api/metrics/api-metrics';
import { describeConfig, loadConfig } from './shared/config/app-config';
import { createDb, createPool } from './shared/db/database';
import { pingDatabase } from './shared/db/ping';
import { waitForDatabase } from './shared/db/wait-for-database';
import { ManagementServer } from './shared/health/management-server';
import { AppLogger } from './shared/logging/app-logger';
import { installProcessGuardrail } from './shared/runtime/process-guardrail';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env, 'api');
  const logger = new AppLogger(config.LOG_LEVEL, 'Api');

  installProcessGuardrail(logger);
  // 실제 적용된 설정값을 한 번 남긴다. 비밀값은 가린다 (ADR-0030).
  logger.log('Configuration applied', describeConfig(config));

  // 연결을 얻거나 쿼리를 기다리다 멈추지 않게 한도를 둔다. 넘으면 503으로 답한다 (ADR-0039).
  const pool = createPool(
    config.DATABASE_URL!,
    'alarm-api',
    10,
    (error) =>
      logger.warn('Database connection lost', { error: error.message }),
    {
      acquireMs: config.DB_ACQUIRE_TIMEOUT_MS,
      queryMs: config.DB_QUERY_TIMEOUT_MS,
    },
  );

  await waitForDatabase(pool, logger);

  const app = await createApiApp(config, pool, logger);

  app.enableShutdownHooks();
  await app.listen(config.PORT);

  // 생존 확인에는 DB를 넣지 않는다. DB 상태는 준비 확인에만 넣는다 (ADR-0026).
  const management = new ManagementServer(
    config.MANAGEMENT_PORT,
    {
      live: () => true,
      ready: () => pingDatabase(pool, 1_000),
      registry: createApiRegistry(createDb(pool)),
    },
    logger,
  );

  await management.start();
  process.once('SIGTERM', () => void management.stop());
  logger.log('Api started', {
    port: config.PORT,
    managementPort: config.MANAGEMENT_PORT,
  });
}

// 시작하지 못하면(설정 오류 등) 요청을 받을 수 없으므로 종료 코드 1로 끝낸다. 로거가 생기기 전일 수 있어 직접 쓴다.
bootstrap().catch((error: unknown) => {
  const { message, stack } = error as Error;

  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', message: `Api failed to start: ${message}`, stack })}\n`,
  );
  process.exit(1);
});
