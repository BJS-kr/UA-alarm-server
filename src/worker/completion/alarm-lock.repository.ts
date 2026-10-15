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

/** 완료 판정의 "끝나지 않은 건" (ADR-0018, 0032). */
const UNFINISHED = [
  DeliveryStatus.PENDING,
  DeliveryStatus.IN_FLIGHT,
  DeliveryStatus.UNCONFIRMED,
];

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
 * 완료 판정. 숫자를 세지 않고 "끝나지 않은 건이 하나라도 있는가"만 본다. 끝나지 않은 건만 담은 부분 인덱스를 쓴다.
 * status는 잠금 아래에서 읽은 알림 상태다. 발송 중이면 COMPLETED, 취소 중이면 CANCELED로 끝낸다.
 * 발송 중인 알림은 펼치기가 끝나기 전에는 전체 수가 정해지지 않으므로 펼치기 완료를 함께 본다.
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
