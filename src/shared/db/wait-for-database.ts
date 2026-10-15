import { LoggerService } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * 기동 시 DB에 연결될 때까지 간격을 늘려 가며 기다린다 (ADR-0026).
 * 연결 실패로 바로 죽지 않으므로 DB가 복구되는 동안 재시작을 반복하지 않는다.
 */
export async function waitForDatabase(pool: Pool, logger: LoggerService, maxWaitMs = 120_000): Promise<void> {
  const startedAt = Date.now();
  let delay = 250;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (Date.now() - startedAt > maxWaitMs) throw error;
      logger.warn('DB 연결을 기다린다', { delayMs: delay, error: (error as Error).message });
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
