import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { DB } from '../../shared/db/database';
import type { Db } from '../../shared/db/database';
import { dbNow } from '../../shared/db/db-clock';
import { alarmRecipients, alarms, deliveries } from '../../shared/db/schema';
import {
  AlarmStatus,
  AlarmType,
  CancelReason,
  DeliveryStatus,
  priorityOf,
} from '../../shared/domain/status';

export type AlarmRow = typeof alarms.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;

export interface NewAlarm {
  type: AlarmType;
  title: string;
  body: string;
}

export interface AlarmListFilter {
  status?: AlarmStatus;
  type?: AlarmType;
  /** 이 ID보다 앞(더 오래된) 알림만. 커서 페이지네이션 (ADR-0024) */
  beforeId?: string;
  limit: number;
}

export interface DeliveryListFilter {
  alarmId: string;
  status?: DeliveryStatus;
  /** 이 수신자 ID 뒤만. 커서 페이지네이션 */
  afterRecipientId?: string;
  limit: number;
}

/** 알림 API의 저장소. 상태 전이는 모두 조건부 UPDATE 한 문장이다 (ADR-0016). */
@Injectable()
export class AlarmsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 알림과, 긴급 알림이면 수신자 정의를 한 트랜잭션에 만든다. */
  create(
    alarm: NewAlarm,
    recipientIds: string[] | undefined,
  ): Promise<AlarmRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(alarms).values(alarm).returning();
      const isWithRecipients = recipientIds !== undefined;
      if (isWithRecipients) {
        await tx.insert(alarmRecipients).values(
          recipientIds.map((recipientId) => ({
            alarmId: row.id,
            recipientId,
          })),
        );
      }

      return row;
    });
  }

  /** 최신순. UUIDv7은 시간순이라 ID 순서가 곧 생성 순서다 (ADR-0024, 0037). */
  list(filter: AlarmListFilter): Promise<AlarmRow[]> {
    return this.db
      .select()
      .from(alarms)
      .where(
        and(
          filter.status === undefined
            ? undefined
            : eq(alarms.status, filter.status),
          filter.type === undefined ? undefined : eq(alarms.type, filter.type),
          filter.beforeId === undefined
            ? undefined
            : lt(alarms.id, filter.beforeId),
        ),
      )
      .orderBy(desc(alarms.id))
      .limit(filter.limit);
  }

  async findById(id: string): Promise<AlarmRow | undefined> {
    const [row] = await this.db.select().from(alarms).where(eq(alarms.id, id));

    return row;
  }

  /** 상태별 Delivery 건수. 저장하지 않고 조회할 때 센다 (ADR-0018). */
  countDeliveriesByStatus(
    alarmId: string,
  ): Promise<{ status: DeliveryStatus; count: number }[]> {
    return this.db
      .select({ status: deliveries.status, count: count() })
      .from(deliveries)
      .where(eq(deliveries.alarmId, alarmId))
      .groupBy(deliveries.status);
  }

  async recipientIdsOf(alarmId: string): Promise<string[]> {
    const rows = await this.db
      .select({ recipientId: alarmRecipients.recipientId })
      .from(alarmRecipients)
      .where(eq(alarmRecipients.alarmId, alarmId))
      .orderBy(asc(alarmRecipients.recipientId));

    return rows.map((row) => row.recipientId);
  }

  /**
   * CREATED → SENDING 전이. 전이 성공 시 갱신된 행을, 실패 시 undefined를 반환한다.
   * 긴급 알림은 동일 트랜잭션에서 수신자 목록으로 Delivery를 즉시 생성하므로 별도의 수신자 확장(Expansion) 단계가 없다 (ADR-0011).
   */
  startSending(id: string): Promise<AlarmRow | undefined> {
    return this.db.transaction(async (tx) => {
      const [started] = await tx
        .update(alarms)
        .set({
          status: AlarmStatus.SENDING,
          startedAt: dbNow,
          startSeq: sql`nextval('alarm_start_seq')`,
          expansionDone: sql`${alarms.type} = ${AlarmType.URGENT}`,
        })
        .where(and(eq(alarms.id, id), eq(alarms.status, AlarmStatus.CREATED)))
        .returning();
      const isUrgentStarted = started?.type === AlarmType.URGENT;
      if (isUrgentStarted) {
        const recipients = await tx
          .select({ recipientId: alarmRecipients.recipientId })
          .from(alarmRecipients)
          .where(eq(alarmRecipients.alarmId, id));

        await tx.insert(deliveries).values(
          recipients.map(({ recipientId }) => ({
            alarmId: id,
            recipientId,
            priority: priorityOf(AlarmType.URGENT),
            startSeq: started.startSeq!,
          })),
        );
      }

      return started;
    });
  }

  /**
   * 취소 1단계 (ADR-0017). 시작 전이면 CREATED → CANCELED, 발송 중이면 SENDING → CANCELING.
   * 전이마다 조건부 UPDATE 한 문장이다. 이 요청이 전이했으면 바뀐 행을, 아니면 undefined를 돌려준다.
   */
  async cancel(id: string): Promise<AlarmRow | undefined> {
    const [canceled] = await this.db
      .update(alarms)
      .set({
        status: AlarmStatus.CANCELED,
        cancelReason: CancelReason.REQUESTED,
        finishedAt: dbNow,
      })
      .where(and(eq(alarms.id, id), eq(alarms.status, AlarmStatus.CREATED)))
      .returning();
    const isCanceledBeforeStart = canceled !== undefined;
    if (isCanceledBeforeStart) return canceled;
    const [canceling] = await this.db
      .update(alarms)
      .set({
        status: AlarmStatus.CANCELING,
        cancelReason: CancelReason.REQUESTED,
      })
      .where(and(eq(alarms.id, id), eq(alarms.status, AlarmStatus.SENDING)))
      .returning();

    return canceling;
  }

  /** 수신자 ID 순. */
  listDeliveries(filter: DeliveryListFilter): Promise<DeliveryRow[]> {
    return this.db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.alarmId, filter.alarmId),
          filter.status === undefined
            ? undefined
            : eq(deliveries.status, filter.status),
          filter.afterRecipientId === undefined
            ? undefined
            : gt(deliveries.recipientId, filter.afterRecipientId),
        ),
      )
      .orderBy(asc(deliveries.recipientId))
      .limit(filter.limit);
  }
}
