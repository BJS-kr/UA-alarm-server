import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNow, dbNowPlus } from '../../shared/db/db-clock';
import { Tx } from '../../shared/db/executor';
import { alarms, deliveries } from '../../shared/db/schema';
import { AlarmStatus, DeliveryStatus } from '../../shared/domain/status';

/** 취소 2단계(PENDING 정리) 저장소 (ADR-0017). 수신자 확장과 동일한 리스 기반 점유 방식을 사용한다 (ADR-0004). */
export class CancellationRepository {
  constructor(
    private readonly db: Db,
    private readonly workerId: number,
  ) {}

  /** PENDING 정리가 완료되지 않은 CANCELING 알림 1건을 점유한다 (미점유 또는 리스 만료 대상). */
  async claim(leaseMs: number): Promise<string | undefined> {
    const next = this.db
      .select({ id: alarms.id })
      .from(alarms)
      .where(
        and(
          eq(alarms.status, AlarmStatus.CANCELING),
          eq(alarms.cleanupDone, false),
          or(isNull(alarms.cleanupOwner), lt(alarms.cleanupLeaseUntil, dbNow)),
        ),
      )
      .limit(1)
      .for('update', { skipLocked: true });
    const [claimed] = await this.db
      .update(alarms)
      .set({
        cleanupOwner: this.workerId,
        cleanupLeaseUntil: dbNowPlus(leaseMs),
      })
      .where(inArray(alarms.id, next))
      .returning({ id: alarms.id });

    return claimed?.id;
  }

  /**
   * 대기 건(재시도 시각을 기다리는 건 포함)을 CANCELED로 바꾸고 정리를 끝냈다고 표시한다.
   * 호출하는 쪽이 알림 행을 잠근 트랜잭션에서 부른다. 바꾼 건수를 돌려준다.
   */
  async cancelPending(tx: Tx, alarmId: string): Promise<number> {
    const result = await tx
      .update(deliveries)
      .set({ status: DeliveryStatus.CANCELED, updatedAt: dbNow })
      .where(
        and(
          eq(deliveries.alarmId, alarmId),
          eq(deliveries.status, DeliveryStatus.PENDING),
        ),
      );

    await tx
      .update(alarms)
      .set({ cleanupDone: true })
      .where(eq(alarms.id, alarmId));

    return result.rowCount ?? 0;
  }
}
