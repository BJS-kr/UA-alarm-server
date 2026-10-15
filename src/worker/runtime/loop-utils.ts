export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** work가 끝나거나 ms가 지나면 끝난다. 먼저 끝나면 타이머를 지워 종료를 붙잡지 않는다. */
export async function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
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
 * DB 쓰기를 간격을 늘려 가며 재시도한다. 끝내 실패하면 onGiveUp을 부른다.
 * 결과를 기록하지 못한 채 계속 돌면 그 건이 살아 있는 워커 명의로 IN_FLIGHT에 영원히 남으므로,
 * 프로세스를 끝내 잠금을 풀고 넘겨받기 경로로 보낸다 (ADR-0007의 두 번째 출구).
 */
export async function durable<T>(fn: () => Promise<T>, onGiveUp: (error: unknown) => never, tries = 6): Promise<T> {
  let delay = 250;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= tries) onGiveUp(error);
      await sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
