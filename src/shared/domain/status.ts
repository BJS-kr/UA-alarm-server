/** Alarm과 Delivery의 상태 (ADR-0008, 0032). 용어는 CONTEXT.md를 따른다. */

export const AlarmType = { BULK: 'BULK', URGENT: 'URGENT' } as const;
export type AlarmType = (typeof AlarmType)[keyof typeof AlarmType];

export const AlarmStatus = {
  CREATED: 'CREATED',
  SENDING: 'SENDING',
  CANCELING: 'CANCELING',
  CANCELED: 'CANCELED',
  COMPLETED: 'COMPLETED',
} as const;
export type AlarmStatus = (typeof AlarmStatus)[keyof typeof AlarmStatus];

export const DeliveryStatus = {
  PENDING: 'PENDING',
  IN_FLIGHT: 'IN_FLIGHT',
  UNCONFIRMED: 'UNCONFIRMED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

/** 꺼내는 순서의 첫 기준. 긴급이 먼저다 (ADR-0011). */
export function priorityOf(type: AlarmType): 0 | 1 {
  return type === AlarmType.URGENT ? 0 : 1;
}

/** 재시도해도 값이 바뀌지 않는 clientRef. 조회 한 번으로 모든 이전 시도를 확인한다 (ADR-0002). */
export function clientRefOf(alarmId: string, recipientId: string): string {
  return `${alarmId}:${recipientId}`;
}
