import { Injectable } from '@nestjs/common';
import {
  ActionResponse,
  cancelResponseFor,
  sendResponseFor,
} from '../../shared/domain/alarm-actions';
import { decodeCursor, encodeCursor } from '../../shared/domain/cursor';
import { AlarmType, DeliveryStatus } from '../../shared/domain/status';
import {
  badRequest,
  FieldError,
  invalidState,
  notFound,
  validationFailed,
} from '../errors/problem';
import {
  AlarmDetailView,
  AlarmListView,
  AlarmView,
  CreateAlarmRequest,
  DeliveryCounts,
  DeliveryListView,
  DeliveryView,
  ListAlarmsQuery,
  ListDeliveriesQuery,
} from './alarms.dto';
import { AlarmRow, AlarmsRepository, DeliveryRow } from './alarms.repository';

const DEFAULT_PAGE_SIZE = 20;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActionResult {
  httpStatus: 200 | 202;
  view: AlarmView;
}

@Injectable()
export class AlarmsService {
  constructor(private readonly alarms: AlarmsRepository) {}

  async create(request: CreateAlarmRequest): Promise<AlarmView> {
    // 실수 한 번으로 전체 사용자에게 나가는 것을 막는다 (ADR-0021).
    const errors: FieldError[] = [];
    const isUrgentWithoutRecipients =
      request.type === AlarmType.URGENT && request.recipientIds === undefined;
    if (isUrgentWithoutRecipients) {
      errors.push({
        field: 'recipientIds',
        message: 'Urgent alarms require recipientIds',
      });
    }

    const isBulkWithRecipients =
      request.type === AlarmType.BULK && request.recipientIds !== undefined;
    if (isBulkWithRecipients) {
      errors.push({
        field: 'recipientIds',
        message: 'Bulk alarms cannot have recipientIds',
      });
    }

    const isInvalid = errors.length > 0;
    if (isInvalid) throw validationFailed(errors);

    const row = await this.alarms.create(
      { type: request.type, title: request.title, body: request.body },
      request.recipientIds,
    );

    return toAlarmView(row);
  }

  async list(query: ListAlarmsQuery): Promise<AlarmListView> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const beforeId =
      query.cursor === undefined ? undefined : decodeAlarmCursor(query.cursor);
    const rows = await this.alarms.list({
      status: query.status,
      type: query.type,
      beforeId,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const isMore = rows.length > limit;

    return {
      items: page.map(toAlarmView),
      nextCursor: isMore ? encodeCursor(page[page.length - 1].id) : null,
    };
  }

  async get(id: string): Promise<AlarmDetailView> {
    const alarm = await this.findAlarm(id);
    const view: AlarmDetailView = {
      ...toAlarmView(alarm),
      counts: toCounts(await this.alarms.countDeliveriesByStatus(id)),
    };
    const isUrgent = alarm.type === AlarmType.URGENT;
    if (isUrgent) view.recipientIds = await this.alarms.recipientIdsOf(id);

    return view;
  }

  /** 발송 시작. CREATED → SENDING (ADR-0016). 이미 시작했거나 끝났으면 현재 상태로 답한다 (ADR-0020). */
  async send(id: string): Promise<ActionResult> {
    // 이 요청이 전이를 했으면 바뀐 행으로 답한다. 다시 읽으면 그사이 들어온 취소 때문에 답이 바뀔 수 있다.
    const alarm =
      (await this.alarms.startSending(id)) ?? (await this.findAlarm(id));

    return respond(alarm, sendResponseFor(alarm.status), 'started');
  }

  /**
   * 취소. 시작 전이면 바로 CANCELED, 발송 중이면 CANCELING으로 바꾸고 바로 응답한다.
   * 대기 건 정리는 워커가 맡는다 (ADR-0017).
   */
  async cancel(id: string): Promise<ActionResult> {
    const alarm = (await this.alarms.cancel(id)) ?? (await this.findAlarm(id));

    return respond(alarm, cancelResponseFor(alarm.status), 'canceled');
  }

  async deliveries(
    id: string,
    query: ListDeliveriesQuery,
  ): Promise<DeliveryListView> {
    await this.findAlarm(id);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const afterRecipientId =
      query.cursor === undefined
        ? undefined
        : decodeRecipientCursor(query.cursor);
    const rows = await this.alarms.listDeliveries({
      alarmId: id,
      status: query.status,
      afterRecipientId,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const isMore = rows.length > limit;

    return {
      items: page.map(toDeliveryView),
      nextCursor: isMore
        ? encodeCursor(page[page.length - 1].recipientId)
        : null,
    };
  }

  private async findAlarm(id: string): Promise<AlarmRow> {
    const alarm = await this.alarms.findById(id);
    const isMissing = alarm === undefined;
    if (isMissing) throw notFound(`Alarm ${id} not found`);

    return alarm;
  }
}

function respond(
  alarm: AlarmRow,
  response: ActionResponse,
  action: 'started' | 'canceled',
): ActionResult {
  const isConflict = response.kind === 'conflict';
  if (isConflict) {
    throw invalidState(
      `An alarm in ${alarm.status} cannot be ${action}`,
      alarm.status,
    );
  }

  return { httpStatus: response.httpStatus, view: toAlarmView(alarm) };
}

function decodeAlarmCursor(cursor: string): string {
  const position = decodeCursor(cursor);
  const isAlarmId = typeof position === 'string' && UUID_PATTERN.test(position);
  if (!isAlarmId) throw badRequest('Invalid cursor');

  return position;
}

function decodeRecipientCursor(cursor: string): string {
  const position = decodeCursor(cursor);
  const isRecipientId = typeof position === 'string';
  if (!isRecipientId) throw badRequest('Invalid cursor');

  return position;
}

function toAlarmView(row: AlarmRow): AlarmView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toDeliveryView(row: DeliveryRow): DeliveryView {
  return {
    recipientId: row.recipientId,
    status: row.status,
    attempts: row.attempts,
    messageId: row.messageId,
    sentAt: row.sentAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCounts(
  rows: { status: DeliveryStatus; count: number }[],
): DeliveryCounts {
  const countOf = (status: DeliveryStatus) =>
    rows.find((row) => row.status === status)?.count ?? 0;
  const counts = {
    pending: countOf(DeliveryStatus.PENDING),
    inFlight: countOf(DeliveryStatus.IN_FLIGHT),
    unconfirmed: countOf(DeliveryStatus.UNCONFIRMED),
    sent: countOf(DeliveryStatus.SENT),
    failed: countOf(DeliveryStatus.FAILED),
    canceled: countOf(DeliveryStatus.CANCELED),
  };

  return { total: Object.values(counts).reduce((a, b) => a + b, 0), ...counts };
}
