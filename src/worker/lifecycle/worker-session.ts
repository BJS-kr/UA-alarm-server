import { LoggerService } from '@nestjs/common';
import { LockConnection } from './lock-connection';
import { workerApplicationName } from './worker-identity';

export interface WorkerSessionOptions {
  connectionString: string;
  workerId: number;
  heartbeatIntervalMs: number;
  sendGuardMs: number;
}

/**
 * 워커의 생존을 DB 세션으로 표현한다 (ADR-0004).
 * - 잠금 연결로 자기 ID의 advisory lock을 잡고 유지한다. 세션이 끝나면 Postgres가 잠금을 푼다.
 * - heartbeatIntervalMs마다 생존 신호를 보낸다.
 * - 잠금 연결을 잃으면 그 자리에서 종료한다. 다시 연결해 이어가는 경로는 없다.
 */
export class WorkerSession {
  private connection?: LockConnection;
  private timer?: NodeJS.Timeout;
  private lastConfirmedAt = 0n;
  private isStopped = false;

  constructor(
    private readonly options: WorkerSessionOptions,
    private readonly logger: LoggerService,
    private readonly onLost: (reason: string) => void,
  ) {}

  async start(): Promise<void> {
    const { connectionString, workerId, sendGuardMs, heartbeatIntervalMs } =
      this.options;
    const connection = new LockConnection(
      connectionString,
      workerApplicationName(workerId, 'lock'),
      sendGuardMs,
      (reason) => this.lose(reason),
    );
    const isLocked = await connection.open(workerId);
    if (!isLocked) {
      await connection.close();
      throw new Error(`Could not acquire the lock for worker ${workerId}`);
    }

    this.connection = connection;
    this.lastConfirmedAt = process.hrtime.bigint();
    this.timer = setInterval(() => void this.heartbeat(), heartbeatIntervalMs);
  }

  /**
   * 발송 직전 확인 (ADR-0004). 잠금 연결이 최근 sendGuardMs 안에 확인됐을 때만 보낸다.
   * 경과 시간은 단조 시계로 잰다.
   */
  canSend(): boolean {
    const isHoldingLock = !this.isStopped && this.connection !== undefined;
    if (!isHoldingLock) return false;
    const elapsedMs =
      Number(process.hrtime.bigint() - this.lastConfirmedAt) / 1e6;

    return elapsedMs < this.options.sendGuardMs;
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    clearInterval(this.timer);
    const connection = this.connection;

    this.connection = undefined;
    await connection?.close().catch(() => undefined);
  }

  private async heartbeat(): Promise<void> {
    const connection = this.connection;
    const isHoldingLock = !this.isStopped && connection !== undefined;
    if (!isHoldingLock) return;
    await connection.ping().then(
      () => {
        this.lastConfirmedAt = process.hrtime.bigint();
      },
      (error: Error) => this.lose(`heartbeat failed: ${error.message}`),
    );
  }

  private lose(reason: string): void {
    if (this.isStopped) return;
    this.isStopped = true;
    clearInterval(this.timer);
    this.logger.error(
      'Lost the worker lock. An invalidated worker never comes back, so the process exits',
      { reason },
    );
    this.onLost(reason);
  }
}
