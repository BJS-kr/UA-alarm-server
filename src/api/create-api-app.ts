import { INestApplication, LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppConfig } from '../shared/config/app-config';
import { ApiModule } from './api.module';
import { traceMiddleware } from './http/trace.middleware';
import { setupOpenApi } from './openapi';

/** 진입점, 테스트, OpenAPI 내보내기가 같은 방식으로 앱을 만든다. */
export async function createApiApp(
  config: AppConfig,
  pool: Pool,
  logger: LoggerService,
): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule.forRoot(config, pool), {
    logger,
  });

  app.use(traceMiddleware(logger));
  setupOpenApi(app);

  return app;
}
