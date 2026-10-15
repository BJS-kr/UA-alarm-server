import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describeConfig, loadConfig } from './shared/config/app-config';
import { ManagementServer } from './shared/health/management-server';
import { AppLogger } from './shared/logging/app-logger';
import { logContext } from './shared/logging/log-context';
import { newWorkerId } from './worker/lifecycle/worker-identity';
import { WorkerRuntime } from './worker/runtime/worker-runtime';
import { WorkerModule } from './worker/worker.module';

async function bootstrap(workerId: number): Promise<void> {
  const config = loadConfig(process.env, 'worker');
  const logger = new AppLogger(config.LOG_LEVEL, 'Worker');
  logger.log('설정 적용', describeConfig(config));

  // 계속 돌면 정확성이 깨지는 상황(잠금 상실, 결과 기록 불가)에서는 그 자리에서 끝낸다.
  // 커널이 소켓을 닫아 잠금이 풀리고, 다른 워커가 넘겨받는다 (ADR-0004, 0007).
  const onFatal = (reason: string, error?: unknown): never => {
    // 원인 오류가 없을 때 undefined를 넘기면 빈 로그 줄이 하나 더 찍힌다.
    if (error === undefined) logger.fatal(reason);
    else logger.fatal(reason, error instanceof Error ? error : String(error));
    process.exit(1);
  };

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, workerId, logger, onFatal), { logger });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  const runtime = app.get(WorkerRuntime);

  // worker의 생존 기준은 HTTP 응답이 아니라 작업 루프의 회전이다 (ADR-0026).
  const management = new ManagementServer(config.MANAGEMENT_PORT, {
    live: () => runtime.isLive(),
    ready: () => runtime.isLive(),
    registry: runtime.metrics.registry,
  });
  await management.start();
  process.once('SIGTERM', () => void management.stop());
}

const workerId = newWorkerId();
logContext.run({ workerId: String(workerId) }, () =>
  bootstrap(workerId).catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: 'fatal', workerId: String(workerId), message: (error as Error).message, stack: (error as Error).stack })}\n`);
    process.exit(1);
  }),
);
