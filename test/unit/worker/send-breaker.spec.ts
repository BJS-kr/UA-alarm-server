import { SendResult } from '../../../src/shared/domain/send-outcome';
import { SendBreaker } from '../../../src/worker/breaker/send-breaker';
import { monotonicMs } from '../../../src/worker/runtime/loop-utils';
import { TokenBucket } from '../../../src/worker/rate-limit/token-bucket';

const failure: SendResult = {
  kind: 'server_error',
  status: 503,
  code: 'SERVICE_UNAVAILABLE',
  message: 'down',
};
const success: SendResult = { kind: 'accepted', messageId: 'm' };
const silent = {
  log: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

/** DB 대신 호출만 기록하는 토큰 버킷 */
function stubBucket() {
  const calls: string[] = [];
  const bucket = {
    tripBreaker: async () => {
      calls.push('trip');

      return { tripped: true, pauseMs: 100, streak: 0 };
    },
    closeBreaker: async () => {
      calls.push('close');
    },
  } as unknown as TokenBucket;

  return { bucket, calls };
}

function breakerWith(bucket: TokenBucket, probes: string[] = []): SendBreaker {
  return new SendBreaker(
    4,
    0.5,
    bucket,
    { pauseMinMs: 100, pauseMaxMs: 1000, streakWindowMs: 60_000 },
    silent,
    () => undefined,
    (result) => probes.push(result),
  );
}

describe('서킷 브레이커 (ADR-0014)', () => {
  it('판단 창의 절반 이상이 실패하면 열고, 열린 동안은 장애 상태다', async () => {
    const { bucket, calls } = stubBucket();
    const breaker = breakerWith(bucket);
    const startedAt = monotonicMs();

    for (const result of [success, failure, success]) {
      await breaker.record(result, startedAt, false);
    }

    expect(breaker.isOpen()).toBe(false);
    await breaker.record(failure, startedAt, false);
    expect(calls).toEqual(['trip']);
    expect(breaker.isOpen()).toBe(true);
  });

  it('열리기 전에 시작한 요청의 결과는 열린 뒤에 도착해도 판단에 쓰지 않는다', async () => {
    const { bucket, calls } = stubBucket();
    const breaker = breakerWith(bucket);
    const startedBeforeOpening = monotonicMs();

    breaker.observe(true); // 다른 워커가 열었다
    await new Promise((r) => setTimeout(r, 5));
    breaker.observe(false); // 시험 발송이 성공해 닫혔다

    // 열리기 전에 나간 요청들이 이제 타임아웃으로 돌아온다
    for (let i = 0; i < 4; i++) {
      await breaker.record(failure, startedBeforeOpening, false);
    }

    expect(calls).toEqual([]);
  });

  it('시험 발송이 성공하면 닫고, 실패하면 다시 연다', async () => {
    const { bucket, calls } = stubBucket();
    const probes: string[] = [];
    const breaker = breakerWith(bucket, probes);

    breaker.observe(true);
    await breaker.record(failure, monotonicMs(), true);
    expect(calls).toEqual(['trip']);
    expect(breaker.isOpen()).toBe(true);

    await breaker.record(success, monotonicMs(), true);
    expect(calls).toEqual(['trip', 'close']);
    expect(breaker.isOpen()).toBe(false);
    expect(probes).toEqual(['still_failing', 'recovered']);
  });

  it('닫히면 판단 창을 비워, 장애 전의 실패로 다시 열지 않는다', async () => {
    const { bucket, calls } = stubBucket();
    const breaker = breakerWith(bucket);

    for (let i = 0; i < 3; i++) {
      await breaker.record(failure, monotonicMs(), false);
    }

    breaker.observe(true);
    breaker.observe(false);
    await new Promise((r) => setTimeout(r, 2));
    await breaker.record(failure, monotonicMs(), false);
    expect(calls).toEqual([]);
  });
});
