import { hasLeaseFor } from '../../../src/shared/domain/lease';

describe('발송 직전 확인 (ADR-0004)', () => {
  it('남은 기한이 응답 한도보다 길 때만 보낸다', () => {
    // 기한 30초, 응답 한도 10초
    expect(hasLeaseFor(30_000, 0, 10_000)).toBe(true);
    expect(hasLeaseFor(30_000, 19_999, 10_000)).toBe(true);
    // 응답 한도까지 걸리면 기한에 닿는다
    expect(hasLeaseFor(30_000, 20_000, 10_000)).toBe(false);
    expect(hasLeaseFor(30_000, 31_000, 10_000)).toBe(false);
  });
});
