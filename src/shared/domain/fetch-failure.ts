/**
 * 외부 사용자 목록 조회 실패 중 재시도 불가능한 영구 오류 상태 코드 (ADR-0006).
 * 5xx, 429, 타임아웃, 네트워크 연결 오류 등 일시적 실패는 지수 백오프로 재시도한다.
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404]);

/** status는 응답의 HTTP 상태다. 응답 없이 실패했으면 undefined다. */
export function isPermanentFetchFailure(status: number | undefined): boolean {
  return status !== undefined && PERMANENT_STATUSES.has(status);
}
