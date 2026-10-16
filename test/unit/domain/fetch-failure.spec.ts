import { isPermanentFetchFailure } from '../../../src/shared/domain/fetch-failure';

describe('사용자 조회 실패의 분류 (ADR-0006)', () => {
  it('요청이나 설정이 틀린 4xx는 다시 해도 같으므로 포기한다', () => {
    for (const status of [400, 401, 403, 404]) {
      expect([status, isPermanentFetchFailure(status)]).toEqual([status, true]);
    }
  });

  it('5xx, 429, 408, 응답 없음은 다시 하면 될 수 있으므로 재시도한다', () => {
    for (const status of [500, 502, 503, 429, 408, 200]) {
      expect([status, isPermanentFetchFailure(status)]).toEqual([
        status,
        false,
      ]);
    }

    expect(isPermanentFetchFailure(undefined)).toBe(false);
  });
});
