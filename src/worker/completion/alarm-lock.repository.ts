import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNow } from '../../shared/db/db-clock';
import { Executor, Tx } from '../../shared/db/executor';
import { alarms, deliveries } from '../../shared/db/schema';
import { AlarmStatus, DeliveryStatus } from '../../shared/domain/status';

export interface LockedAlarm {
  status: AlarmStatus;
  expansionOwner: number | null;
  expansionCursor: string | null;
  cleanupOwner: number | null;
}

/** 완료 판정 시 미종결로 간주하는 Delivery 상태 (ADR-0018, 0032). */
const UNFINISHED = [
  DeliveryStatus.PENDING,
  DeliveryStatus.IN_FLIGHT,
  DeliveryStatus.UNCONFIRMED,
];

/**
 * 알림 행 잠금(FOR NO KEY UPDATE) 트랜잭션 내에서 fn을 실행하고 완료 판정을 수행한다 (ADR-0018).
 * Delivery 상태 갱신 및 취소 정리 등 모든 후속 전이 경로가 이 함수를 거친다.
 *
 * - 동일 알림의 상태 갱신을 직렬화하여 마지막 트랜잭션이 정확히 완료(COMPLETED/CANCELED)를 판정한다.
 * - 상태 기록과 완료 판정이 단일 트랜잭션으로 묶여 별도의 주기적 완료 폴링이 불필요하다.
 * - 잠금 하에서 알림 상태를 읽으므로 취소 1단계와 경합하지 않는다 (ADR-0017).
 * - FOR NO KEY UPDATE를 사용하여 Delivery INSERT 시의 외래 키(KEY SHARE) 잠금과 충돌하지 않는다.
 */
export async function withAlarmLock<T>(
  db: Db,
  alarmId: string,
  fn: (tx: Tx, alarm: LockedAlarm) => Promise<T>,
): Promise<{ result: T; finished: AlarmStatus | null }> {
  return db.transaction(async (tx) => {
    const [alarm] = await tx
      .select({
        status: alarms.status,
        expansionOwner: alarms.expansionOwner,
        expansionCursor: alarms.expansionCursor,
        cleanupOwner: alarms.cleanupOwner,
      })
      .from(alarms)
      .where(eq(alarms.id, alarmId))
      .for('no key update');
    const isMissing = alarm === undefined;
    if (isMissing) throw new Error(`Alarm ${alarmId} does not exist`);
    const result = await fn(tx, alarm);
    const finished = await finalizeIfDone(tx, alarmId, alarm.status);

    return { result, finished };
  });
}

/**
 * 알림 완료 판정. 미종결 부분 인덱스(deliveries_unfinished_idx)에 대해 NOT EXISTS로 잔여 건 유무만 확인한다.
 * SENDING 상태에서는 수신자 확장 완료(expansion_done = true) 조건을 함께 검사한다.
 */
async function finalizeIfDone(
  executor: Executor,
  alarmId: string,
  status: AlarmStatus,
): Promise<AlarmStatus | null> {
  const isCanceling = status === AlarmStatus.CANCELING;
  const isSending = status === AlarmStatus.SENDING;
  const isInProgress = isCanceling || isSending;
  if (!isInProgress) return null;

  const [finished] = await executor
    .update(alarms)
    .set({
      status: isCanceling ? AlarmStatus.CANCELED : AlarmStatus.COMPLETED,
      finishedAt: dbNow,
    })
    .where(
      and(
        eq(alarms.id, alarmId),
        eq(alarms.status, status),
        isCanceling ? undefined : eq(alarms.expansionDone, true),
        notExists(
          executor
            .select({ one: sql`1` })
            .from(deliveries)
            .where(
              and(
                eq(deliveries.alarmId, alarmId),
                inArray(deliveries.status, UNFINISHED),
              ),
            ),
        ),
      ),
    )
    .returning({ status: alarms.status });

  return finished?.status ?? null;
}
