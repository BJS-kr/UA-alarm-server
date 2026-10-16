import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { dbNow, dbNowPlus } from '../../shared/db/db-clock';
import { Tx } from '../../shared/db/executor';
import { alarms, deliveries } from '../../shared/db/schema';
import {
  AlarmStatus,
  AlarmType,
  CancelReason,
  priorityOf,
} from '../../shared/domain/status';

export interface ExpansionTask {
  alarmId: string;
  cursor: string | null;
  startSeq: number;
}

/** 수신자 확장(Expansion) 저장소 (ADR-0006). 리스 및 펜싱 기반 점유 방식을 사용한다 (ADR-0004). */
export class ExpansionRepository {
  constructor(
    private readonly db: Db,
    private readonly workerId: number,
  ) {}

  /**
   * 수신자 확장 대상 알림 1건을 발송 시작 순번(start_seq) 순으로 점유한다 (ADR-0012).
   * 미점유 또는 리스 만료 건뿐 아니라 현재 워커가 이미 점유 중인 건도 재점유할 수 있도록 허용하여,
   * 페이지 커밋 직후 응답 유실로 루프가 재진입하더라도 리스 만료 대기 없이 이어서 처리한다.
   */
  async claim(leaseMs: number): Promise<ExpansionTask | undefined> {
    const next = this.db
      .select({ id: alarms.id })
      .from(alarms)
      .where(
        and(
          eq(alarms.status, AlarmStatus.SENDING),
          eq(alarms.expansionDone, false),
          or(
            isNull(alarms.expansionOwner),
            eq(alarms.expansionOwner, this.workerId),
            lt(alarms.expansionLeaseUntil, dbNow),
          ),
        ),
      )
      .orderBy(asc(alarms.startSeq))
      .limit(1)
      .for('update', { skipLocked: true });
    const [task] = await this.db
      .update(alarms)
      .set({
        expansionOwner: this.workerId,
        expansionLeaseUntil: dbNowPlus(leaseMs),
      })
      .where(inArray(alarms.id, next))
      .returning({
        alarmId: alarms.id,
        cursor: alarms.expansionCursor,
        startSeq: alarms.startSeq,
      });

    // SENDING 알림에는 발송 시작 시 부여된 start_seq가 존재한다.
    return task && { ...task, startSeq: task.startSeq! };
  }

  /**
   * 점유 리스를 now + leaseMs로 갱신한다. 알림이 SENDING 상태이고 현재 워커가 소유자일 때만 반영된다.
   * false 반환 시 취소되었거나 다른 워커에 인계된 것이므로 확장을 중단한다 (ADR-0004, 0017).
   */
  async renew(task: ExpansionTask, leaseMs: number): Promise<boolean> {
    const renewed = await this.db
      .update(alarms)
      .set({ expansionLeaseUntil: dbNowPlus(leaseMs) })
      .where(this.myTask(task))
      .returning({ id: alarms.id });

    return renewed.length > 0;
  }

  /**
   * 영구 오류로 인해 수신자 확장을 중단하고 알림을 CANCELING(EXPANSION_FAILED)으로 전이한다 (ADR-0006, 0017).
   * 기발송 건은 유지되며 미발송 PENDING 건은 취소 2단계에서 CANCELED로 정리된다.
   */
  async abandon(
    task: ExpansionTask,
    error: { code: string; message: string },
  ): Promise<boolean> {
    const abandoned = await this.db
      .update(alarms)
      .set({
        status: AlarmStatus.CANCELING,
        cancelReason: CancelReason.EXPANSION_FAILED,
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        expansionOwner: null,
        expansionLeaseUntil: null,
      })
      .where(this.myTask(task))
      .returning({ id: alarms.id });

    return abandoned.length > 0;
  }

  /** 정상 종료 시 점유를 해제하여 다른 워커가 리스 만료 대기 없이 이어받도록 한다 (ADR-0007). */
  async release(task: ExpansionTask): Promise<void> {
    await this.db
      .update(alarms)
      .set({ expansionOwner: null, expansionLeaseUntil: null })
      .where(this.myTask(task));
  }

  /**
   * 한 페이지의 Delivery를 삽입하고 다음 커서를 저장한다 (알림 행 잠금 트랜잭션 내에서 호출).
   * (alarm_id, recipient_id) UNIQUE 제약과 ON CONFLICT DO NOTHING으로 재시도 시 중복 삽입을 방지한다.
   */
  async savePage(
    tx: Tx,
    task: ExpansionTask,
    recipientIds: string[],
    nextCursor: string | null,
  ): Promise<void> {
    const isEmptyPage = recipientIds.length === 0;
    if (!isEmptyPage) {
      await tx
        .insert(deliveries)
        .values(
          recipientIds.map((recipientId) => ({
            alarmId: task.alarmId,
            recipientId,
            priority: priorityOf(AlarmType.BULK),
            startSeq: task.startSeq,
          })),
        )
        .onConflictDoNothing();
    }

    await tx
      .update(alarms)
      .set({ expansionCursor: nextCursor, expansionDone: nextCursor === null })
      .where(
        and(
          eq(alarms.id, task.alarmId),
          eq(alarms.expansionOwner, this.workerId),
        ),
      );
  }

  /** SENDING 상태이면서 미완료이고 현재 워커가 점유 중인 알림 조건 */
  private myTask(task: ExpansionTask) {
    return and(
      eq(alarms.id, task.alarmId),
      eq(alarms.status, AlarmStatus.SENDING),
      eq(alarms.expansionDone, false),
      eq(alarms.expansionOwner, this.workerId),
    );
  }
}
