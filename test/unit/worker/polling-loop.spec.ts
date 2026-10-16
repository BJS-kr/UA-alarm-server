import { durable, monotonicMs } from '../../../src/worker/runtime/loop-utils';
import { PollingLoop } from '../../../src/worker/runtime/polling-loop';

const silent = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

describe('작업 루프 (ADR-0007, 0039)', () => {
  it('바퀴 안에서 오래 쉬는 중이어도 멈추라는 요청에 바로 멈춘다', async () => {
    let isPausing = false;

    const loop: PollingLoop = new PollingLoop(
      { name: 'test', idleMs: 10, logger: silent, onError: () => undefined },
      async () => {
        isPausing = true;
        await loop.pause(60_000); // 펼치기의 재시도 대기처럼 바퀴 안에서 길게 쉰다

        return 'busy';
      },
    );

    loop.start();
    while (!isPausing) await new Promise((r) => setTimeout(r, 1));
    const startedAt = monotonicMs();

    await loop.stop();
    expect(monotonicMs() - startedAt).toBeLessThan(1000);
  });

  it('바퀴 사이에 쉬는 중이어도 바로 멈춘다', async () => {
    const loop = new PollingLoop(
      {
        name: 'test',
        idleMs: 60_000,
        logger: silent,
        onError: () => undefined,
      },
      async () => 'idle',
    );

    loop.start();
    await new Promise((r) => setTimeout(r, 10));
    const startedAt = monotonicMs();

    await loop.stop();
    expect(monotonicMs() - startedAt).toBeLessThan(1000);
  });
});

describe('DB 쓰기 재시도 (ADR-0039)', () => {
  it('실패하다 성공하면 그 결과를 돌려준다', async () => {
    let calls = 0;
    const result = await durable(async () => {
      calls += 1;
      if (calls < 3) throw new Error('down');

      return 'ok';
    }, 3);

    expect([result, calls]).toEqual(['ok', 3]);
  });

  it('끝내 실패하면 프로세스를 끝내지 않고 마지막 오류를 던진다', async () => {
    let calls = 0;

    await expect(
      durable(async () => {
        calls += 1;
        throw new Error(`down ${calls}`);
      }, 2),
    ).rejects.toThrow('down 2');
    expect(calls).toBe(2);
  });
});
