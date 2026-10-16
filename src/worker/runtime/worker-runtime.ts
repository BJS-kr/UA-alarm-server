import { LoggerService } from '@nestjs/common';
import { Pool } from 'pg';
import { AppConfig } from '../../shared/config/app-config';
import { createDb, createPool, Db } from '../../shared/db/database';
import { waitForDatabase } from '../../shared/db/wait-for-database';
import { ExternalApiClient } from '../../shared/external/external-api.client';
import { SendBreaker } from '../breaker/send-breaker';
import { CancellationRepository } from '../cancellation/cancellation.repository';
import { Canceller } from '../cancellation/canceller';
import { DeliveryRepository } from '../dispatch/delivery.repository';
import { Dispatcher } from '../dispatch/dispatcher';
import { Expander } from '../expansion/expander';
import { ExpansionRepository } from '../expansion/expansion.repository';
import { Housekeeper } from '../lifecycle/housekeeper';
import { workerApplicationName } from '../lifecycle/worker-identity';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { TokenBucket } from '../rate-limit/token-bucket';
import { Reconciler } from '../reconcile/reconciler';

export interface WorkerRuntimeOptions {
  config: AppConfig;
  workerId: number;
  logger: LoggerService;
}

/**
 * 워커의 DB 연결 풀. 트랜잭션 도중 멈춘 워커의 세션은 Postgres가 끝내 행 잠금을 푼다 (ADR-0004).
 * 시간 제한(PoolTimeouts)은 두지 않는다. 멈춘 워커가 쥔 잠금이 풀리기를 기다리는 것은 정상이다.
 */
export function createWorkerPool(
  config: AppConfig,
  workerId: number,
  max: number,
  onConnectionError?: (error: Error) => void,
): Pool {
  return createPool(
    config.DATABASE_URL!,
    workerApplicationName(workerId),
    max,
    onConnectionError,
    undefined,
    config.IDLE_TX_TIMEOUT_MS,
  );
}

/** 워커 한 대를 이루는 부품을 조립하고, 켜고 끄는 순서를 정한다. */
export class WorkerRuntime {
  readonly metrics = new WorkerMetrics();
  readonly workerId: number;
  private readonly pool: Pool;
  private readonly loopPool: Pool;
  private readonly db: Db;
  private readonly client: ExternalApiClient;
  private readonly dispatcher: Dispatcher;
  private readonly reconciler: Reconciler;
  private readonly expander: Expander;
  private readonly canceller: Canceller;
  private readonly housekeeper: Housekeeper;

  constructor(private readonly options: WorkerRuntimeOptions) {
    const { config, workerId, logger } = options;

    this.workerId = workerId;
    const onDbError = (error: Error) =>
      logger.warn('Database connection lost', { error: error.message });

    this.pool = createWorkerPool(config, workerId, 10, onDbError);
    this.db = createDb(this.pool);
    // 토큰 획득 및 발송 대상 점유(claim) 전용 커넥션 풀. 결과 기록 트랜잭션과의 커넥션 경합을 분리한다.
    this.loopPool = createWorkerPool(config, workerId, 2, onDbError);
    const loopDb = createDb(this.loopPool);

    this.client = new ExternalApiClient(
      config.EXTERNAL_API_BASE_URL,
      config.MAX_IN_FLIGHT,
    );
    const deliveries = new DeliveryRepository(this.db, workerId, loopDb);
    // 프로브 발송의 리스 시간은 일반 발송 리스(DELIVERY_LEASE_MS)와 동일하게 설정한다.
    const bucket = new TokenBucket(
      loopDb,
      config.RATE_LIMIT_PER_SEC,
      config.RATE_BUCKET_CAPACITY,
      config.DELIVERY_LEASE_MS,
    );
    const breaker = new SendBreaker(
      config.BREAKER_WINDOW,
      config.BREAKER_FAILURE_RATIO,
      bucket,
      {
        pauseMinMs: config.BREAKER_PAUSE_MIN_MS,
        pauseMaxMs: config.BREAKER_PAUSE_MAX_MS,
        streakWindowMs: config.BREAKER_STREAK_WINDOW_MS,
      },
      logger,
      () => this.metrics.breakerTrips.inc(),
      (result) => this.metrics.breakerProbes.inc({ result }),
    );

    this.dispatcher = new Dispatcher({
      config,
      deliveries,
      bucket,
      client: this.client,
      breaker,
      metrics: this.metrics,
      logger,
    });
    this.reconciler = new Reconciler(
      config,
      deliveries,
      this.client,
      this.metrics,
      logger,
    );
    this.expander = new Expander(
      config,
      this.db,
      new ExpansionRepository(this.db, workerId),
      workerId,
      this.client,
      this.metrics,
      logger,
    );
    this.canceller = new Canceller(
      config,
      this.db,
      new CancellationRepository(this.db, workerId),
      workerId,
      this.metrics,
      logger,
    );
    this.housekeeper = new Housekeeper(
      config,
      deliveries,
      this.metrics,
      logger,
    );
  }

  async start(): Promise<void> {
    await waitForDatabase(this.pool, this.options.logger);
    this.housekeeper.start();
    this.dispatcher.start();
    this.reconciler.start();
    this.expander.start();
    this.canceller.start();
    this.options.logger.log('Worker started', { workerId: this.workerId });
  }

  isLive(): boolean {
    return this.dispatcher.isLive();
  }

  /**
   * 정상 종료(Graceful shutdown, ADR-0007): 신규 점유를 중단하고 진행 중인 발송 결과를 기록한 뒤,
   * 미전송 건과 수신자 확장 점유를 반납하고 커넥션을 종료한다.
   */
  async stop(): Promise<void> {
    this.options.logger.log('Graceful shutdown started');
    await this.dispatcher.stop(this.options.config.SHUTDOWN_GRACE_MS);
    await Promise.all([
      this.reconciler.stop(),
      this.expander.stop(),
      this.canceller.stop(),
      this.housekeeper.stop(),
    ]);
    this.client.close();
    await this.pool.end();
    await this.loopPool.end();
    this.options.logger.log('Graceful shutdown complete');
  }
}
