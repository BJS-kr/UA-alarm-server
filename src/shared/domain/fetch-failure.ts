/**
 * 사용자 조회 실패 중 다시 해도 결과가 같은 것 (ADR-0006). 요청이 틀렸거나(400) 우리 설정이 틀렸다(401·403·404).
 * 5xx, 429, 타임아웃, 연결 오류처럼 다시 하면 될 수 있는 실패는 백오프로 재시도한다.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);

/** status는 응답의 HTTP 상태다. 응답 없이 실패했으면 undefined다. */
export function isPermanentFetchFailure(status: number | undefined): boolean {
  return status !== undefined && PERMANENT_STATUSES.has(status);
}
