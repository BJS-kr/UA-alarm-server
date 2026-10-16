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

/** 수신자 펼치기의 저장소 (ADR-0006). 점유 방식은 ADR-0004와 같다: 담당(owner)과 기한, 펜싱. */
export class ExpansionRepository {
  constructor(
    private readonly db: Db,
    private readonly workerId: number,
  ) {}

  /**
   * 펼치기 작업 하나를 쥔다. 먼저 시작한 알림부터 (ADR-0012).
   * 아무도 쥐지 않았거나 기한이 지난 작업에 더해, 이미 내가 쥔 작업도 다시 집는다.
   * 페이지 커밋의 응답만 유실되면 재시도가 "이미 들어간 페이지"로 보고 멈추는데, 그 작업이 내 이름으로 남아도 이어 가기 위해서다.
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

    // SENDING 알림에는 발송 시작 때 매긴 시작 순번이 있다.
    return task && { ...task, startSeq: task.startSeq! };
  }

  /**
   * 기한을 지금 + leaseMs로 연장한다. 알림이 아직 SENDING이고 내가 담당일 때만 반영된다.
   * false면 취소됐거나 넘겨받힌 것이므로 펼치기를 멈춘다 (ADR-0004, 0017).
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
   * 다시 해도 안 되는 실패로 펼치기를 포기하고 알림을 취소 중으로 돌린다 (ADR-0006, 0017).
   * 이미 나간 건은 그대로 두고, 남은 건은 취소 2단계(대기 건 정리)가 CANCELED로 바꾼다.
   * 취소 이유와 마지막 오류를 남겨 운영자가 사람이 취소한 것과 구별하게 한다. 이미 취소됐거나 넘겨받혔으면 false다.
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

  /** 정상 종료할 때 담당을 내려놓는다. 다른 워커가 기한을 기다리지 않고 이어 간다 (ADR-0007). */
  async release(task: ExpansionTask): Promise<void> {
    await this.db
      .update(alarms)
      .set({ expansionOwner: null, expansionLeaseUntil: null })
      .where(this.myTask(task));
  }

  /**
   * 한 페이지의 Delivery를 넣고 다음 커서를 저장한다. 호출하는 쪽이 알림 행을 잠근 트랜잭션에서 부른다.
   * (알림, 수신자) 유일 제약이 있어 같은 페이지를 다시 넣어도 중복 행이 생기지 않는다.
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

  /** 아직 펼치는 중이고 내가 담당인 그 알림 */
  private myTask(task: ExpansionTask) {
    return and(
      eq(alarms.id, task.alarmId),
      eq(alarms.status, AlarmStatus.SENDING),
      eq(alarms.expansionDone, false),
      eq(alarms.expansionOwner, this.workerId),
    );
  }
}
