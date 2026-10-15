import { LoggerService } from '@nestjs/common';
import { monotonicMs, sleep } from './loop-utils';

/**
 * 한 바퀴의 결과. 'busy'면 쉬지 않고 다음 바퀴를 돌고, 'idle'이면 idleMs를, { sleepMs }면 그만큼 쉰다.
 */
export type Tick = 'busy' | 'idle' | { sleepMs: number };

export interface PollingLoopOptions {
  name: string;
  idleMs: number;
  logger: LoggerService;
  /** 한 바퀴가 예상하지 못한 오류로 끝났을 때. 메트릭을 올린다. */
  onError: (loopName: string) => void;
}

/**
 * 워커의 작업 루프 하나 (ADR-0039). 멈추라는 요청이 올 때까지 tick을 반복한다.
 * tick이 예상하지 못한 오류로 끝나도 루프는 죽지 않는다. 로그와 메트릭으로 남기고 잠깐 쉰 뒤 이어 간다.
 * 그래서 루프를 쓰는 모듈은 try/catch 없이 한 바퀴에 할 일만 쓴다.
 */
export class PollingLoop {
  private isStopRequested = false;
  private done: Promise<void> = Promise.resolve();
  private lastTickAt = monotonicMs();

  constructor(
    private readonly options: PollingLoopOptions,
    private readonly tick: () => Promise<Tick>,
  ) {}

  start(): void {
    this.done = this.run();
  }

  /** 돌던 바퀴를 마치고 멈춘다. */
  async stop(): Promise<void> {
    this.isStopRequested = true;
    await this.done;
  }

  get isStopping(): boolean {
    return this.isStopRequested;
  }

  /** 최근 staleMs 안에 한 바퀴 이상 시작했는가. 끝나지 않는 쿼리에 걸린 루프를 찾는다 (ADR-0026). */
  isTurning(staleMs: number): boolean {
    return monotonicMs() - this.lastTickAt < staleMs;
  }

  private async run(): Promise<void> {
    while (!this.isStopRequested) {
      this.lastTickAt = monotonicMs();
      const pauseMs = this.pauseAfter(await this.safeTick());
      const isBusy = pauseMs === 0;
      if (!isBusy) await sleep(pauseMs);
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
