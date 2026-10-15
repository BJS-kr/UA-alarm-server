import { randomBytes } from 'node:crypto';

/**
 * 프로세스가 뜰 때마다 새로 뽑는 무작위 워커 ID (ADR-0004).
 * 컨테이너 이름(worker-1)은 재시작해도 같아서, 부활한 워커가 이전 생의 건을 자기 것으로 착각한다.
 * 같은 값을 owner와 advisory lock 번호로 함께 쓴다. 2^52 미만의 양수라 JS number와
 * pg_locks의 (classid, objid) 복원에서 부호 문제가 없다.
 */
export function newWorkerId(): number {
  const bytes = randomBytes(7);
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return (value % 2 ** 52) + 1;
}

/** 무효 선언이 워커의 모든 세션을 찾을 수 있도록 application_name에 ID를 단다 (ADR-0004). */
export function workerApplicationName(workerId: number, role: 'lock' | 'pool'): string {
  return `alarm-worker:${workerId}:${role}`;
}
