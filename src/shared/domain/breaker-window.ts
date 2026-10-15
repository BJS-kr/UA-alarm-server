/**
 * 워커마다 최근 발송 결과 N건을 기억하고, 그중 실패 비율이 기준 이상이면 장애로 판단한다 (ADR-0014).
 * 판단 기준은 서버 생존이 아니라 발송 결과다.
 */
export class BreakerWindow {
  private readonly results: boolean[] = [];

  constructor(
    private readonly size: number,
    private readonly failureRatio: number,
  ) {}

  /** 결과를 기록하고, 이번 기록으로 장애 판단 기준을 넘었는지 돌려준다. 넘으면 창을 비운다. */
  record(failed: boolean): boolean {
    this.results.push(failed);
    const isOverflowing = this.results.length > this.size;
    if (isOverflowing) this.results.shift();
    const isWindowFilling = this.results.length < this.size;
    if (isWindowFilling) return false;
    const failures = this.results.filter(Boolean).length;
    const isOutage = failures / this.size >= this.failureRatio;
    if (isOutage) {
      this.results.length = 0;

      return true;
    }

    return false;
  }
}
