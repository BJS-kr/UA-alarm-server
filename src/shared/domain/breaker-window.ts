/**
 * 워커마다 가장 최근에 시작한 발송 N건의 결과를 기억하고, 그중 실패 비율이 기준 이상이면 장애로 판단한다 (ADR-0014).
 * 판단 기준은 서버 생존이 아니라 발송 결과다.
 *
 * 결과가 도착한 순서가 아니라 요청을 시작한 순서로 최근 N건을 본다. 성공은 바로 오고 타임아웃은 응답 한도 뒤에 오므로,
 * 도착 순서로 보면 발송이 갑자기 줄어드는 순간(알림 막바지, 429 정지) 그 전에 보낸 건의 타임아웃만 몰려 장애처럼 보인다.
 */
export class BreakerWindow {
  /** 시작 시각 순으로 정렬해 둔다. */
  private readonly results: Array<{ startedAt: number; failed: boolean }> = [];

  constructor(
    private readonly size: number,
    private readonly failureRatio: number,
  ) {}

  /** 브레이커가 닫혔다. 장애 전의 결과로 다시 판단하지 않게 비운다. */
  reset(): void {
    this.results.length = 0;
  }

  /**
   * 결과를 기록하고, 이번 기록으로 장애 판단 기준을 넘었는지 돌려준다. 넘으면 창을 비운다.
   * startedAt은 그 요청을 시작한 시각이다. 시작 순서 자리에 넣고 가장 먼저 시작한 건을 밀어내므로,
   * 창에 든 어느 건보다 먼저 시작한 결과는 넣자마자 자기가 밀려나 판단에 쓰이지 않는다.
   */
  record(failed: boolean, startedAt: number): boolean {
    const later = this.results.findIndex((r) => r.startedAt > startedAt);

    this.results.splice(later === -1 ? this.results.length : later, 0, {
      startedAt,
      failed,
    });
    const isOverflowing = this.results.length > this.size;
    if (isOverflowing) this.results.shift();
    const isWindowFilling = this.results.length < this.size;
    if (isWindowFilling) return false;
    const failures = this.results.filter((r) => r.failed).length;
    const isOutage = failures / this.size >= this.failureRatio;
    if (isOutage) {
      this.results.length = 0;

      return true;
    }

    return false;
  }
}
