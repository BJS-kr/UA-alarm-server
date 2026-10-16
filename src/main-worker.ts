import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describeConfig, loadConfig } from './shared/config/app-config';
import { ManagementServer } from './shared/health/management-server';
import { AppLogger } from './shared/logging/app-logger';
import { logContext } from './shared/logging/log-context';
import { installProcessGuardrail } from './shared/runtime/process-guardrail';
import { newWorkerId } from './worker/lifecycle/worker-identity';
import { WorkerRuntime } from './worker/runtime/worker-runtime';
import { WorkerModule } from './worker/worker.module';

async function bootstrap(workerId: number): Promise<void> {
  const config = loadConfig(process.env, 'worker');
  const logger = new AppLogger(config.LOG_LEVEL, 'Worker');

  installProcessGuardrail(logger);
  logger.log('Configuration applied', describeConfig(config));

  const app = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(config, workerId, logger),
    { logger },
  );

  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const runtime = app.get(WorkerRuntime);

  // worker의 생존 기준은 HTTP 응답이 아니라 작업 루프의 회전이다 (ADR-0026).
  const management = new ManagementServer(
    config.MANAGEMENT_PORT,
    {
      live: () => runtime.isLive(),
      ready: () => runtime.isLive(),
      registry: runtime.metrics.registry,
    },
    logger,
  );

  await management.start();
  process.once('SIGTERM', () => void management.stop());
}

// 시작하지 못하면(설정 오류 등) 일을 할 수 없으므로 종료 코드 1로 끝낸다. 로거가 생기기 전일 수 있어 직접 쓴다.
const workerId = newWorkerId();

logContext.run({ workerId: String(workerId) }, () =>
  bootstrap(workerId).catch((error: unknown) => {
    const { message, stack } = error as Error;

    process.stderr.write(
      `${JSON.stringify({ level: 'fatal', workerId: String(workerId), message: `Worker failed to start: ${message}`, stack })}\n`,
    );
    process.exit(1);
  }),
);
