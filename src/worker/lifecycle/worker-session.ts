import { LoggerService } from '@nestjs/common';
import { Client } from 'pg';
import { workerApplicationName } from './worker-identity';

export interface WorkerSessionOptions {
  connectionString: string;
  workerId: number;
  heartbeatIntervalMs: number;
  sendGuardMs: number;
}

/**
 * 워커의 생존을 DB 세션으로 표현한다 (ADR-0004).
 * - 전용 연결로 자기 ID의 advisory lock을 잡고 유지한다. 세션이 끝나면 Postgres가 잠금을 푼다.
 * - 2초마다 SELECT 1로 생존 신호를 남긴다. DB는 연결별 마지막 활동 시각을 기록한다.
 * - 잠금 연결을 잃으면 그 자리에서 종료한다. 다시 연결해 이어가는 경로는 없다.
 */
export class WorkerSession {
  private client?: Client;
  private timer?: NodeJS.Timeout;
  private lastConfirmedAt = 0n;
  private stopped = false;

  constructor(
    private readonly options: WorkerSessionOptions,
    private readonly logger: LoggerService,
    private readonly onLost: (reason: string) => void,
  ) {}

  async start(): Promise<void> {
    const client = new Client({
      connectionString: this.options.connectionString,
      application_name: workerApplicationName(this.options.workerId, 'lock'),
    });
    client.on('error', (error) => this.lose(`잠금 연결 오류: ${error.message}`));
    client.on('end', () => this.lose('잠금 연결이 끊겼다'));
    await client.connect();
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      this.options.workerId,
    ]);
    if (!result.rows[0]?.locked) {
      await client.end();
      throw new Error(`워커 ID ${this.options.workerId}의 잠금을 잡지 못했다`);
    }
    this.client = client;
    this.lastConfirmedAt = process.hrtime.bigint();
    this.timer = setInterval(() => void this.heartbeat(), this.options.heartbeatIntervalMs);
  }

  /**
   * 발송 직전 확인 (ADR-0004). 잠금 연결이 최근 sendGuardMs 안에 확인됐을 때만 보낸다.
   * 경과 시간은 단조 시계로 잰다.
   */
  canSend(): boolean {
    if (this.stopped || !this.client) return false;
    const elapsedMs = Number(process.hrtime.bigint() - this.lastConfirmedAt) / 1e6;
    return elapsedMs < this.options.sendGuardMs;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    const client = this.client;
    this.client = undefined;
    // 연결을 닫으면 advisory lock도 함께 풀린다.
    await client?.end().catch(() => undefined);
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || !this.client) return;
    try {
      await this.client.query('SELECT 1');
      this.lastConfirmedAt = process.hrtime.bigint();
    } catch (error) {
      this.lose(`생존 신호 실패: ${(error as Error).message}`);
    }
  }

  private lose(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.logger.error('잠금을 잃었다. 무효가 된 워커는 되살아나지 않으므로 종료한다', { reason });
    this.onLost(reason);
  }
}
