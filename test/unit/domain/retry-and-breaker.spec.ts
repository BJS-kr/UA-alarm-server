import { BreakerWindow } from '../../../src/shared/domain/breaker-window';
import { breakerPauseMs, retryDelayMs } from '../../../src/shared/domain/retry-policy';

describe('지수 백오프 + 지터 (ADR-0014)', () => {
  const options = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0.2 };

  it('지터가 없으면 1초에서 시작해 두 배씩 늘고 60초에서 멈춘다', () => {
    const noJitter = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => retryDelayMs(a, options, noJitter))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
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
    expect([0, 1, 2, 3, 4, 5].map((s) => breakerPauseMs(s, 5000, 60_000))).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  });
});

describe('서킷 브레이커 판단 창 (ADR-0014)', () => {
  it('창이 차기 전에는 발동하지 않는다', () => {
    const window = new BreakerWindow(4, 0.5);
    expect([true, true, true].map((f) => window.record(f))).toEqual([false, false, false]);
  });

  it('최근 N건 중 실패 비율이 기준 이상이면 발동하고 창을 비운다', () => {
    const window = new BreakerWindow(4, 0.5);
    expect([false, false, true].map((f) => window.record(f))).toEqual([false, false, false]);
    expect(window.record(true)).toBe(true);
    // 창이 비워졌으므로 다시 4건이 쌓여야 판단한다.
    expect(window.record(true)).toBe(false);
  });

  it('기준 미만이면 발동하지 않고 오래된 결과는 밀려난다', () => {
    const window = new BreakerWindow(4, 0.5);
    [true, false, false, false].forEach((f) => window.record(f));
    expect(window.record(false)).toBe(false);
    expect(window.record(true)).toBe(false);
    expect(window.record(true)).toBe(true);
  });

  it('평소 오류율 5% 수준으로는 발동하지 않는다', () => {
    const window = new BreakerWindow(20, 0.5);
    let tripped = false;
    for (let i = 0; i < 1000; i++) tripped = window.record(i % 20 === 0) || tripped;
    expect(tripped).toBe(false);
  });
});
