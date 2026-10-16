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
 * DB 쓰기를 간격을 늘려 가며 재시도한다. 끝내 실패하면 마지막 오류를 던진다.
 * 프로세스는 끝내지 않는다. 기록하지 못한 건은 기한이 지나 다른 워커가 넘겨받고(ADR-0004),
 * 오류는 루프 꼭대기가 받아 로그와 메트릭으로 남긴다(ADR-0039).
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
