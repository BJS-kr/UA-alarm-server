import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { Db } from '../../shared/db/database';
import { Tx } from '../../shared/db/executor';
import { alarms, deliveries } from '../../shared/db/schema';
import { AlarmStatus, AlarmType, priorityOf } from '../../shared/domain/status';
import { ownerIsGone } from '../lifecycle/workers.repository';

export interface ExpansionTask {
  alarmId: string;
  cursor: string | null;
  startSeq: number;
}

/** 수신자 펼치기의 저장소 (ADR-0006). 점유 방식은 ADR-0004와 같다. */
export class ExpansionRepository {
  constructor(
    private readonly db: Db,
    private readonly workerId: number,
  ) {}

  /**
   * 펼치기 작업 하나를 쥔다. 먼저 시작한 알림부터 (ADR-0012).
   * 아무도 쥐지 않았거나 주인이 사라진 작업에 더해, 이미 내가 쥔 작업도 다시 집는다.
   * 페이지 커밋의 응답만 유실되면 재시도가 "이미 들어간 페이지"로 보고 멈추는데, 그 작업이 내 이름으로 남아도 이어 가기 위해서다.
   */
  async claim(): Promise<ExpansionTask | undefined> {
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
            ownerIsGone(alarms.expansionOwner),
          ),
        ),
      )
      .orderBy(asc(alarms.startSeq))
      .limit(1)
      .for('update', { skipLocked: true });
    const [task] = await this.db
      .update(alarms)
      .set({ expansionOwner: this.workerId })
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
}
