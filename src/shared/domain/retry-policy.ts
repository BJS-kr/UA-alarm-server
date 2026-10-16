/**
 * 건별 재시도: 지수 백오프 + 지터 (ADR-0014).
 * attempt는 방금 실패한 시도의 번호(1부터)다. 첫 실패 뒤 간격은 base다.
 */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  jitterRatio: number;
}

export function retryDelayMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(options.baseMs * 2 ** exponent, options.maxMs);
  const jitter = 1 + options.jitterRatio * (2 * random() - 1);

  return Math.max(0, Math.round(raw * jitter));
}

/** 서킷 브레이커 정지 시간: 5초에서 시작해 연달아 발동할 때마다 두 배, 최대 60초 (ADR-0014). */
export function breakerPauseMs(
  streak: number,
  minMs: number,
  maxMs: number,
): number {
  return Math.min(minMs * 2 ** Math.max(0, streak), maxMs);
}

/** 토큰을 0개 받았을 때 쉬는 시간의 하한과 상한 (ADR-0009). 상한은 긴급 알림이 더 기다릴 수 있는 최대 시간이다. */
export const TOKEN_WAIT_MIN_MS = 5;
export const TOKEN_WAIT_MAX_MS = 100;

/**
 * 토큰을 0개 받았을 때 다시 요청하기까지 쉬는 시간 (ADR-0009).
 * 연달아 0개면 두 배씩 늘리고(상한 100ms), 실제로는 그 값의 절반~전부 사이에서 무작위로 정한다.
 * 0개는 다른 워커가 먼저 가져간 충돌이다. 이더넷의 지수 백오프처럼 경쟁이 심할수록 덜 두드리게 되고,
 * 기다리는 동안 토큰이 쌓여 한 번에 여러 개를 받는다. 워커 수를 알 필요가 없다.
 * emptyGrants는 이번을 포함해 연달아 0개를 받은 횟수(1부터), waitMs는 다음 토큰까지 남은 시간이다.
 */
export function tokenRetryWaitMs(
  emptyGrants: number,
  waitMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(waitMs, TOKEN_WAIT_MIN_MS);
  const backoff = Math.min(
    base * 2 ** Math.max(0, emptyGrants - 1),
    TOKEN_WAIT_MAX_MS,
  );

  return Math.max(
    TOKEN_WAIT_MIN_MS,
    Math.round(backoff * (0.5 + random() / 2)),
  );
}
