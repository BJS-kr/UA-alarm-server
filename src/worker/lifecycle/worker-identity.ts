import { randomBytes } from 'node:crypto';

/**
 * 프로세스가 뜰 때마다 새로 뽑는 무작위 워커 ID (ADR-0004). owner 칸에 적어 펜싱에 쓴다.
 * 컨테이너 이름(worker-1)은 재시작해도 같아서, 이전 생이 남긴 건과 지금의 건을 쓰기 조건으로 구별할 수 없다.
 * 2^52 미만의 양수라 JS number로 정확히 다룬다.
 */
export function newWorkerId(): number {
  const bytes = randomBytes(7);
  let value = 0;

  for (const byte of bytes) value = value * 256 + byte;

  return (value % 2 ** 52) + 1;
}

/** pg_stat_activity에서 어느 워커의 연결인지 알아볼 수 있도록 application_name에 ID를 단다. */
export function workerApplicationName(workerId: number): string {
  return `alarm-worker:${workerId}`;
}
