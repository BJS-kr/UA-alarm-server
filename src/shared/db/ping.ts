import { Pool } from 'pg';

/** 준비 확인용: SELECT 1이 제한 시간 안에 끝나면 true (ADR-0026). */
export async function pingDatabase(
  pool: Pool,
  timeoutMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const query = pool.query('SELECT 1').then(
    () => true,
    () => false,
  );

  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
