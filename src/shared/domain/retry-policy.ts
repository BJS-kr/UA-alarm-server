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
