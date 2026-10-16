/**
 * 발송 직전 확인 (ADR-0004). 남은 기한이 응답 한도보다 길 때만 보낸다.
 * 요청이 응답 한도까지 걸려도 기한 안에 끝나야, 정상인 건이 넘겨받히지 않고 결과도 펜싱에 걸리지 않는다.
 * 시각은 모두 같은 단조 시계의 ms다.
 */
export function hasLeaseFor(
  leaseDeadlineMs: number,
  nowMs: number,
  sendTimeoutMs: number,
): boolean {
  return leaseDeadlineMs - nowMs > sendTimeoutMs;
}
