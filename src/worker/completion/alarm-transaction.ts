import { sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { Executor, Tx } from '../../shared/db/executor';
import { AlarmStatus } from '../../shared/domain/status';

export interface LockedAlarm {
  status: AlarmStatus;
  expansionOwner: number | null;
  expansionCursor: string | null;
  cleanupOwner: number | null;
}

/**
 * 알림 행을 잠근 트랜잭션 안에서 fn을 실행하고, 같은 트랜잭션에서 완료 판정을 한다 (ADR-0018).
 * Delivery를 최종 상태로 바꾸거나 PENDING으로 되돌리는 모든 경로가 이 함수를 거친다.
 *
 * - 알림 행을 잠그면 같은 알림의 기록이 한 줄로 선다. 뒤의 트랜잭션은 앞의 커밋을 본 뒤 확인하므로
 *   (READ COMMITTED는 문장마다 새 스냅숏을 쓴다) 진짜 마지막 기록만 "남은 건 없음"을 본다.
 * - 판정이 기록과 한 트랜잭션이라 기록과 판정 사이에 죽는 틈이 없다. 반복 확인이 필요 없다.
 * - 알림 상태를 잠금 아래에서 읽으므로 취소 1단계와 순서가 엇갈리지 않는다 (ADR-0017).
 * - FOR NO KEY UPDATE는 Delivery INSERT가 외래 키 확인으로 잡는 KEY SHARE와 충돌하지 않는다.
 */
export async function withAlarmLock<T>(
  db: Db,
  alarmId: string,
  fn: (tx: Tx, alarm: LockedAlarm) => Promise<T>,
): Promise<{ result: T; finished: AlarmStatus | null }> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{
      status: AlarmStatus;
      expansion_owner: number | null;
      expansion_cursor: string | null;
      cleanup_owner: number | null;
    }>(sql`
      SELECT status, expansion_owner, expansion_cursor, cleanup_owner
        FROM alarms WHERE id = ${alarmId}
         FOR NO KEY UPDATE`);
    const row = locked.rows[0];
    if (!row) throw new Error(`알림 ${alarmId}이(가) 없다`);
    const result = await fn(tx, {
      status: row.status,
      expansionOwner: row.expansion_owner,
      expansionCursor: row.expansion_cursor,
      cleanupOwner: row.cleanup_owner,
    });
    const finished = await finalizeIfDone(tx, alarmId);
    return { result, finished };
  });
}

/**
 * 완료 판정. 숫자를 세지 않고 "끝나지 않은 건이 하나라도 있는가"만 본다.
 * 펼치기 중에는 전체 수가 정해지지 않기 때문이다. 끝나지 않은 건만 담은 부분 인덱스를 쓴다.
 */
export async function finalizeIfDone(executor: Executor, alarmId: string): Promise<AlarmStatus | null> {
  const result = await executor.execute<{ status: AlarmStatus }>(sql`
    UPDATE alarms
       SET status = CASE WHEN status = 'SENDING' THEN 'COMPLETED' ELSE 'CANCELED' END,
           finished_at = clock_timestamp()
     WHERE id = ${alarmId}
       AND ((status = 'SENDING' AND expansion_done) OR status = 'CANCELING')
       AND NOT EXISTS (
             SELECT 1 FROM deliveries
              WHERE alarm_id = ${alarmId}
                AND status IN ('PENDING', 'IN_FLIGHT', 'UNCONFIRMED'))
    RETURNING status`);
  return result.rows[0]?.status ?? null;
}
