import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt, sql, SQL } from 'drizzle-orm';
import { DB, Db } from '../../shared/db/database';
import { alarmRecipients, alarms, deliveries } from '../../shared/db/schema';
import { cancelResponseFor, sendResponseFor } from '../../shared/domain/alarm-actions';
import { decodeCursor, encodeCursor } from '../../shared/domain/cursor';
import { AlarmStatus, AlarmType, DeliveryStatus } from '../../shared/domain/status';
import { badRequest, FieldError, invalidState, notFound, validationFailed } from '../errors/problem';
import {
  AlarmDetailView,
  AlarmListView,
  AlarmView,
  CreateAlarmRequest,
  DeliveryCounts,
  DeliveryListView,
  ListAlarmsQuery,
  ListDeliveriesQuery,
} from './alarms.dto';

type AlarmRow = typeof alarms.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AlarmsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(request: CreateAlarmRequest): Promise<AlarmView> {
    // 실수 한 번으로 전체 사용자에게 나가는 것을 막는다 (ADR-0021).
    const errors: FieldError[] = [];
    if (request.type === AlarmType.URGENT && request.recipientIds === undefined) {
      errors.push({ field: 'recipientIds', message: '긴급 알림은 recipientIds가 필요하다' });
    }
    if (request.type === AlarmType.BULK && request.recipientIds !== undefined) {
      errors.push({ field: 'recipientIds', message: '대량 알림에는 수신자를 지정할 수 없다' });
    }
    if (errors.length > 0) throw validationFailed(errors);

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(alarms)
        .values({ type: request.type, title: request.title, body: request.body })
        .returning();
      if (request.type === AlarmType.URGENT) {
        await tx
          .insert(alarmRecipients)
          .values(request.recipientIds!.map((recipientId) => ({ alarmId: row.id, recipientId })));
      }
      return toAlarmView(row);
    });
  }

  async list(query: ListAlarmsQuery): Promise<AlarmListView> {
    const limit = query.limit ?? 20;
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(alarms.status, query.status));
    if (query.type) conditions.push(eq(alarms.type, query.type));
    if (query.cursor) {
      const position = decodeCursor(query.cursor);
      if (typeof position !== 'string' || !UUID_PATTERN.test(position)) throw badRequest('cursor가 올바르지 않다');
      // UUIDv7은 시간순이라 ID 순서가 곧 생성 순서다 (ADR-0024, 0037).
      conditions.push(lt(alarms.id, position));
    }
    const rows = await this.db
      .select()
      .from(alarms)
      .where(and(...conditions))
      .orderBy(desc(alarms.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toAlarmView),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].id) : null,
    };
  }

  async get(id: string): Promise<AlarmDetailView> {
    const alarm = await this.findAlarm(id);
    // 건수는 저장하지 않고 조회할 때 센다 (ADR-0018).
    const counted = await this.db.execute<{ status: DeliveryStatus; n: number }>(
      sql`SELECT status, count(*)::int AS n FROM deliveries WHERE alarm_id = ${id} GROUP BY status`,
    );
    const view: AlarmDetailView = { ...toAlarmView(alarm), counts: toCounts(counted.rows) };
    if (alarm.type === AlarmType.URGENT) {
      const recipients = await this.db
        .select({ recipientId: alarmRecipients.recipientId })
        .from(alarmRecipients)
        .where(eq(alarmRecipients.alarmId, id))
        .orderBy(asc(alarmRecipients.recipientId));
      view.recipientIds = recipients.map((r) => r.recipientId);
    }
    return view;
  }

  /**
   * 발송 시작. CREATED → SENDING 전이는 조건부 UPDATE 한 문장이다 (ADR-0016).
   * 긴급 알림은 같은 트랜잭션에서 수신자 정의로 Delivery를 바로 만든다 (ADR-0011).
   */
  async send(id: string): Promise<{ httpStatus: 200 | 202; view: AlarmView }> {
    await this.db.transaction(async (tx) => {
      const started = await tx.execute<{ type: AlarmType; start_seq: number }>(sql`
        UPDATE alarms
           SET status = 'SENDING',
               started_at = clock_timestamp(),
               start_seq = nextval('alarm_start_seq'),
               expansion_done = (type = 'URGENT')
         WHERE id = ${id} AND status = 'CREATED'
        RETURNING type, start_seq`);
      const row = started.rows[0];
      if (row?.type === AlarmType.URGENT) {
        await tx.execute(sql`
          INSERT INTO deliveries (alarm_id, recipient_id, priority, start_seq)
          SELECT alarm_id, recipient_id, 0, ${row.start_seq}
            FROM alarm_recipients
           WHERE alarm_id = ${id}`);
      }
    });
    // 성공했든 0건이든 현재 상태로 응답을 정한다. 상태는 앞으로만 움직이므로 다시 읽어도 답이 같다.
    const alarm = await this.findAlarm(id);
    const response = sendResponseFor(alarm.status as AlarmStatus);
    if (response.kind === 'conflict') {
      throw invalidState(`${alarm.status} 상태의 알림은 발송을 시작할 수 없다`, alarm.status);
    }
    return { httpStatus: response.httpStatus, view: toAlarmView(alarm) };
  }

  /**
   * 취소. 시작 전이면 바로 CANCELED, 발송 중이면 CANCELING으로 바꾸고 바로 응답한다.
   * 대기 건 정리는 워커가 맡는다 (ADR-0017).
   */
  async cancel(id: string): Promise<{ httpStatus: 200 | 202; view: AlarmView }> {
    await this.db.execute(sql`
      UPDATE alarms
         SET status = CASE WHEN status = 'CREATED' THEN 'CANCELED' ELSE 'CANCELING' END,
             finished_at = CASE WHEN status = 'CREATED' THEN clock_timestamp() ELSE finished_at END
       WHERE id = ${id} AND status IN ('CREATED', 'SENDING')`);
    const alarm = await this.findAlarm(id);
    const response = cancelResponseFor(alarm.status as AlarmStatus);
    if (response.kind === 'conflict') {
      throw invalidState(`${alarm.status} 상태의 알림은 취소할 수 없다`, alarm.status);
    }
    return { httpStatus: response.httpStatus, view: toAlarmView(alarm) };
  }

  async deliveries(id: string, query: ListDeliveriesQuery): Promise<DeliveryListView> {
    await this.findAlarm(id);
    const limit = query.limit ?? 20;
    const conditions: SQL[] = [eq(deliveries.alarmId, id)];
    if (query.status) conditions.push(eq(deliveries.status, query.status));
    if (query.cursor) {
      const position = decodeCursor(query.cursor);
      if (typeof position !== 'string') throw badRequest('cursor가 올바르지 않다');
      conditions.push(gt(deliveries.recipientId, position));
    }
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(and(...conditions))
      .orderBy(asc(deliveries.recipientId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((d) => ({
        recipientId: d.recipientId,
        status: d.status as DeliveryStatus,
        attempts: d.attempts,
        messageId: d.messageId,
        sentAt: d.sentAt?.toISOString() ?? null,
        lastErrorCode: d.lastErrorCode,
        lastErrorMessage: d.lastErrorMessage,
        updatedAt: d.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].recipientId) : null,
    };
  }

  private async findAlarm(id: string): Promise<AlarmRow> {
    const [alarm] = await this.db.select().from(alarms).where(eq(alarms.id, id));
    if (!alarm) throw notFound(`알림 ${id}이(가) 없다`);
    return alarm;
  }
}

function toAlarmView(row: AlarmRow): AlarmView {
  return {
    id: row.id,
    type: row.type as AlarmType,
    title: row.title,
    body: row.body,
    status: row.status as AlarmStatus,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toCounts(rows: { status: DeliveryStatus; n: number }[]): DeliveryCounts {
  const by = (status: DeliveryStatus) => rows.find((r) => r.status === status)?.n ?? 0;
  const counts = {
    pending: by(DeliveryStatus.PENDING),
    inFlight: by(DeliveryStatus.IN_FLIGHT),
    unconfirmed: by(DeliveryStatus.UNCONFIRMED),
    sent: by(DeliveryStatus.SENT),
    failed: by(DeliveryStatus.FAILED),
    canceled: by(DeliveryStatus.CANCELED),
  };
  return { total: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
}
