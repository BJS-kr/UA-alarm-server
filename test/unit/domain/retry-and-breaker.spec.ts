import { BreakerWindow } from '../../../src/shared/domain/breaker-window';
import {
  breakerPauseMs,
  retryDelayMs,
  tokenRetryWaitMs,
} from '../../../src/shared/domain/retry-policy';

describe('지수 백오프 + 지터 (ADR-0014)', () => {
  const options = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0.2 };

  it('지터가 없으면 1초에서 시작해 두 배씩 늘고 60초에서 멈춘다', () => {
    const noJitter = () => 0.5;

    expect(
      [1, 2, 3, 4, 5, 6, 7, 8].map((a) => retryDelayMs(a, options, noJitter)),
    ).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('지터는 ±20% 안에서 섞인다', () => {
    expect(retryDelayMs(2, options, () => 0)).toBe(1600);
    expect(retryDelayMs(2, options, () => 1)).toBe(2400);
  });

  it('0번째 이하 시도도 기본 간격을 넘지 않는다', () => {
    expect(retryDelayMs(0, options, () => 0.5)).toBe(1000);
  });
});

describe('서킷 브레이커 정지 시간 (ADR-0014)', () => {
  it('5초에서 시작해 연달아 발동할 때마다 두 배, 최대 60초', () => {
    expect(
      [0, 1, 2, 3, 4, 5].map((s) => breakerPauseMs(s, 5000, 60_000)),
    ).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });
});

describe('서킷 브레이커 판단 창 (ADR-0014)', () => {
  /** 결과를 시작한 순서대로 기록한다. 시작 시각은 1씩 늘린다. */
  const inOrder = (window: BreakerWindow) => {
    let startedAt = 0;

    return (failed: boolean) => window.record(failed, (startedAt += 1));
  };

  it('창이 차기 전에는 발동하지 않는다', () => {
    const record = inOrder(new BreakerWindow(4, 0.5));

    expect([true, true, true].map(record)).toEqual([false, false, false]);
  });

  it('최근 N건 중 실패 비율이 기준 이상이면 발동하고 창을 비운다', () => {
    const record = inOrder(new BreakerWindow(4, 0.5));

    expect([false, false, true].map(record)).toEqual([false, false, false]);
    expect(record(true)).toBe(true);
    // 창이 비워졌으므로 다시 4건이 쌓여야 판단한다.
    expect(record(true)).toBe(false);
  });

  it('기준 미만이면 발동하지 않고 오래된 결과는 밀려난다', () => {
    const record = inOrder(new BreakerWindow(4, 0.5));

    [true, false, false, false].forEach(record);
    expect(record(false)).toBe(false);
    expect(record(true)).toBe(false);
    expect(record(true)).toBe(true);
  });

  it('평소 오류율 5% 수준으로는 발동하지 않는다', () => {
    const record = inOrder(new BreakerWindow(20, 0.5));
    let tripped = false;

    for (let i = 0; i < 1000; i++) {
      tripped = record(i % 20 === 0) || tripped;
    }

    expect(tripped).toBe(false);
  });

  it('창에 든 어느 건보다 먼저 시작한 결과는 늦게 도착해도 판단에 쓰지 않는다', () => {
    const window = new BreakerWindow(4, 0.5);

    // 시작 시각 10~13의 성공이 먼저 도착하고, 그 전에 시작한 요청의 타임아웃이 뒤늦게 몰려 온다.
    [10, 11, 12, 13].forEach((t) => window.record(false, t));

    expect([1, 2, 3, 4, 5].map((t) => window.record(true, t))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('늦게 도착해도 창 안의 시각에 시작한 결과는 시작 순서 자리에 넣어 판단한다', () => {
    const window = new BreakerWindow(4, 0.5);

    [10, 12, 14, 16].forEach((t) => window.record(false, t));
    expect(window.record(true, 15)).toBe(false);
    // 창은 시작 시각 12, 14, 15, 16. 13에 시작한 실패가 들어오면 12가 밀려나 실패가 절반이 된다.
    expect(window.record(true, 13)).toBe(true);
  });
});

describe('토큰을 0개 받았을 때의 백오프 (ADR-0009)', () => {
  const full = () => 1;

  it('처음에는 다음 토큰까지 쉬고, 연달아 0개면 두 배씩 늘려 100ms에서 멈춘다', () => {
    expect([1, 2, 3, 4, 5].map((n) => tokenRetryWaitMs(n, 10, full))).toEqual([
      10, 20, 40, 80, 100,
    ]);
  });

  it('실제로 쉬는 시간은 그 값의 절반~전부 사이다', () => {
    expect(tokenRetryWaitMs(3, 10, () => 0)).toBe(20);
    expect(tokenRetryWaitMs(3, 10, () => 0.5)).toBe(30);
  });

  it('다음 토큰이 바로 생겨도 최소 5ms는 쉰다', () => {
    expect(tokenRetryWaitMs(1, 0, full)).toBe(5);
    expect(tokenRetryWaitMs(1, 6, () => 0)).toBe(5);
  });
});
