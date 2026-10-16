import { LoggerService } from '@nestjs/common';
import { monotonicMs } from './loop-utils';

/**
 * 폴링 주기 1회의 반환값. 'busy'면 즉시 다음 주기를 실행하고, 'idle'이면 idleMs만큼, { sleepMs }면 지정 시간만큼 대기한다.
 */
export type Tick = 'busy' | 'idle' | { sleepMs: number };

export interface PollingLoopOptions {
  name: string;
  idleMs: number;
  logger: LoggerService;
  /** 폴링 주기에서 처리되지 않은 예외 발생 시 호출되는 콜백 (메트릭 집계용). */
  onError: (loopName: string) => void;
}

/**
 * 워커 백그라운드 폴링 루프 (ADR-0039). 중지 요청 시까지 tick 함수를 반복 실행한다.
 * 개별 주기에서 예외가 발생해도 루프를 중단하지 않고 로깅 및 메트릭 기록 후 idleMs 대기 뒤 재개한다.
 */
export class PollingLoop {
  private isStopRequested = false;
  private done: Promise<void> = Promise.resolve();
  private lastTickAt = monotonicMs();
  private wake?: () => void;

  constructor(
    private readonly options: PollingLoopOptions,
    private readonly tick: () => Promise<Tick>,
  ) {}

  start(): void {
    this.done = this.run();
  }

  /** 현재 실행 중인 주기를 마친 후 루프를 종료한다. */
  async stop(): Promise<void> {
    this.isStopRequested = true;
    this.wake?.();
    await this.done;
  }

  /**
   * 지정 시간(ms)만큼 대기하되, stop() 호출 시 즉시 깨어난다.
   * 루프 내부에서 백오프 대기를 수행할 때도 사용하여 정상 종료(graceful shutdown) 지연을 방지한다 (ADR-0007).
   */
  pause(ms: number): Promise<void> {
    if (this.isStopRequested) return Promise.resolve();

    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);

      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  get isStopping(): boolean {
    return this.isStopRequested;
  }

  /** 최근 staleMs 이내에 새 주기가 시작되었는지 확인한다 (무한 대기 쿼리 감지용 liveness 기준, ADR-0026). */
  isTurning(staleMs: number): boolean {
    return monotonicMs() - this.lastTickAt < staleMs;
  }

  private async run(): Promise<void> {
    while (!this.isStopRequested) {
      this.lastTickAt = monotonicMs();
      const pauseMs = this.pauseAfter(await this.safeTick());
      const isBusy = pauseMs === 0;
      if (!isBusy) await this.pause(pauseMs);
    }
  }

  private async safeTick(): Promise<Tick> {
    try {
      return await this.tick();
    } catch (error) {
      this.options.onError(this.options.name);
      this.options.logger.error(
        `${this.options.name} loop iteration failed`,
        error as Error,
      );

      return 'idle';
    }
  }

  private pauseAfter(tick: Tick): number {
    const isBusy = tick === 'busy';
    if (isBusy) return 0;
    const isIdle = tick === 'idle';
    if (isIdle) return this.options.idleMs;

    return tick.sleepMs;
  }
}
