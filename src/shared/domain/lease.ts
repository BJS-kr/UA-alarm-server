/**
 * 발송 직전 잔여 리스(lease) 검증 (ADR-0004). 잔여 리스가 발송 타임아웃보다 클 때만 전송한다.
 * 발송 요청이 타임아웃까지 소요되더라도 리스 만료 전에 완료되어야 리스 회수 및 펜싱 충돌을 방지할 수 있다.
 * 모든 시각 인자는 동일 단조 시계(monotonic clock) 기준의 ms 값이다.
 */
export function hasLeaseFor(
  leaseDeadlineMs: number,
  nowMs: number,
  sendTimeoutMs: number,
): boolean {
  return leaseDeadlineMs - nowMs > sendTimeoutMs;
}
