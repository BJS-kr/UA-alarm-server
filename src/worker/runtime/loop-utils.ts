export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** work가 끝나거나 ms가 지나면 끝난다. 먼저 끝나면 타이머를 지워 종료를 붙잡지 않는다. */
export async function waitAtMost(
  work: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });

  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 단조 시계 기준 ms. 벽시계 보정에 영향받지 않는다. */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * DB 쓰기 일시 실패 시 지수 백오프로 재시도하며, 최종 실패 시 마지막 예외를 던진다.
 * 프로세스를 종료하지 않으며, 미기록 건은 리스 만료 후 회수(Takeover, ADR-0004)되고
 * 예외는 폴링 루프 최상위 경계에서 로깅 및 메트릭으로 집계된다 (ADR-0039).
 */
export async function durable<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let delay = 250;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt >= tries;
      if (isLastAttempt) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
