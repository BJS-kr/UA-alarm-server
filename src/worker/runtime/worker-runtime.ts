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
import { WorkerSession } from '../lifecycle/worker-session';
import { WorkerMetrics } from '../metrics/worker-metrics';
import { TokenBucket } from '../rate-limit/token-bucket';
import { Reconciler } from '../reconcile/reconciler';

export interface WorkerRuntimeOptions {
  config: AppConfig;
  workerId: number;
  logger: LoggerService;
  /** 계속 돌면 정확성이 깨지는 상황. 프로세스를 끝내 잠금을 풀고 넘겨받기 경로로 보낸다 (ADR-0007). */
  onFatal: (reason: string, error?: unknown) => never;
}

/** 워커 한 대를 이루는 부품을 조립하고, 켜고 끄는 순서를 정한다. */
export class WorkerRuntime {
  readonly metrics = new WorkerMetrics();
  readonly workerId: number;
  private readonly pool: Pool;
  private readonly loopPool: Pool;
  private readonly housekeepingPool: Pool;
  private readonly db: Db;
  private readonly client: ExternalApiClient;
  private readonly session: WorkerSession;
  private readonly dispatcher: Dispatcher;
  private readonly reconciler: Reconciler;
  private readonly expander: Expander;
  private readonly canceller: Canceller;
  private readonly housekeeper: Housekeeper;

  constructor(private readonly options: WorkerRuntimeOptions) {
    const { config, workerId, logger, onFatal } = options;

    this.workerId = workerId;
    const onDbError = (error: Error) =>
      logger.warn('Database connection lost', { error: error.message });

    this.pool = createPool(
      config.DATABASE_URL!,
      workerApplicationName(workerId, 'pool'),
      10,
      onDbError,
    );
    this.db = createDb(this.pool);
    // 토큰 받기와 꺼내기 전용. 결과 기록 트랜잭션과 연결을 다투지 않게 따로 둔다.
    this.loopPool = createPool(
      config.DATABASE_URL!,
      workerApplicationName(workerId, 'pool'),
      2,
      onDbError,
    );
    const loopDb = createDb(this.loopPool);

    // 무효 선언과 넘겨받기 전용. 다른 워커가 알림 행 잠금을 쥔 채 멈추면, 결과 기록 트랜잭션들이 그 잠금을 기다리며
    // 기본 풀을 모두 붙잡는다. 그 잠금을 푸는 것이 무효 선언이므로, 무효 선언은 연결을 따로 가져야 한다 (ADR-0004).
    this.housekeepingPool = createPool(
      config.DATABASE_URL!,
      workerApplicationName(workerId, 'pool'),
      1,
      onDbError,
    );
    const housekeepingDb = createDb(this.housekeepingPool);

    this.client = new ExternalApiClient(
      config.EXTERNAL_API_BASE_URL,
      config.MAX_IN_FLIGHT,
    );
    this.session = new WorkerSession(
      {
        connectionString: config.DATABASE_URL!,
        workerId,
        heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
        sendGuardMs: config.SEND_GUARD_MS,
      },
      logger,
      (reason) => onFatal(`Lost the worker lock: ${reason}`),
    );
    const deliveries = new DeliveryRepository(this.db, workerId, loopDb);
    const bucket = new TokenBucket(
      loopDb,
      config.RATE_LIMIT_PER_SEC,
      config.RATE_BUCKET_CAPACITY,
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
    );

    this.dispatcher = new Dispatcher({
      config,
      deliveries,
      bucket,
      client: this.client,
      session: this.session,
      breaker,
      metrics: this.metrics,
      logger,
      onFatal,
    });
    this.reconciler = new Reconciler(
      config,
      deliveries,
      this.client,
      this.metrics,
      logger,
      onFatal,
    );
    this.expander = new Expander(
      config,
      this.db,
      new ExpansionRepository(this.db, workerId),
      workerId,
      this.client,
      this.metrics,
      logger,
      onFatal,
    );
    this.canceller = new Canceller(
      config,
      this.db,
      new CancellationRepository(this.db, workerId),
      workerId,
      this.metrics,
      logger,
      onFatal,
    );
    this.housekeeper = new Housekeeper(
      config,
      housekeepingDb,
      new DeliveryRepository(housekeepingDb, workerId, housekeepingDb),
      workerId,
      this.metrics,
      logger,
    );
  }

  async start(): Promise<void> {
    await waitForDatabase(this.pool, this.options.logger);
    // 잠금부터 잡는다. 잠금 없이 건을 쥐면 다른 워커가 주인 없는 건으로 보고 넘겨받는다.
    await this.session.start();
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
   * 정상 종료 (ADR-0007): 새 건을 꺼내지 않고, 보낸 요청의 결과를 기록하고,
   * 보내지 않은 건은 반납한 뒤, 잠금 연결을 닫는다.
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
    await this.session.stop();
    this.client.close();
    await this.pool.end();
    await this.loopPool.end();
    await this.housekeepingPool.end();
    this.options.logger.log('Graceful shutdown complete');
  }
}
