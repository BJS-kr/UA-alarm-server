import {
  cancelResponseFor,
  sendResponseFor,
} from '../../../src/shared/domain/alarm-actions';
import { decodeCursor, encodeCursor } from '../../../src/shared/domain/cursor';
import {
  AlarmStatus,
  AlarmType,
  clientRefOf,
  priorityOf,
} from '../../../src/shared/domain/status';

describe('발송 시작 응답 (ADR-0016, 0020)', () => {
  it('발송 중이면 202, 완료면 200: 이미 목표 상태면 성공이다', () => {
    expect(sendResponseFor(AlarmStatus.SENDING)).toEqual({
      kind: 'success',
      httpStatus: 202,
    });
    expect(sendResponseFor(AlarmStatus.COMPLETED)).toEqual({
      kind: 'success',
      httpStatus: 200,
    });
  });

  it('취소 중이거나 취소된 알림은 시작할 수 없다(409)', () => {
    expect(sendResponseFor(AlarmStatus.CANCELING)).toEqual({
      kind: 'conflict',
    });
    expect(sendResponseFor(AlarmStatus.CANCELED)).toEqual({ kind: 'conflict' });
  });

  it('CREATED로는 응답을 정하지 않는다: 전이가 실패했는데 CREATED일 수는 없다', () => {
    expect(() => sendResponseFor(AlarmStatus.CREATED)).toThrow();
  });
});

describe('취소 응답 (ADR-0016, 0020)', () => {
  it('취소 중이면 202, 취소됐으면 200', () => {
    expect(cancelResponseFor(AlarmStatus.CANCELING)).toEqual({
      kind: 'success',
      httpStatus: 202,
    });
    expect(cancelResponseFor(AlarmStatus.CANCELED)).toEqual({
      kind: 'success',
      httpStatus: 200,
    });
  });

  it('완료된 알림은 취소할 수 없다(409)', () => {
    expect(cancelResponseFor(AlarmStatus.COMPLETED)).toEqual({
      kind: 'conflict',
    });
  });

  it('CREATED·SENDING으로는 응답을 정하지 않는다', () => {
    expect(() => cancelResponseFor(AlarmStatus.CREATED)).toThrow();
    expect(() => cancelResponseFor(AlarmStatus.SENDING)).toThrow();
  });
});

describe('우선순위와 clientRef', () => {
  it('긴급이 0, 대량이 1이라 정렬하면 긴급이 먼저다 (ADR-0011)', () => {
    expect(priorityOf(AlarmType.URGENT)).toBe(0);
    expect(priorityOf(AlarmType.BULK)).toBe(1);
  });

  it('clientRef는 알림과 수신자로 고정되어 재시도해도 바뀌지 않는다 (ADR-0002)', () => {
    expect(clientRefOf('a-1', 'u_000001')).toBe('a-1:u_000001');
  });
});

describe('목록 커서 (ADR-0024)', () => {
  it('위치를 감춘 값으로 왕복한다', () => {
    expect(decodeCursor(encodeCursor('01a1-uuid'))).toBe('01a1-uuid');
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(encodeCursor('u_000001')).not.toContain('u_000001');
  });

  it('형식이 틀리면 undefined다', () => {
    expect(decodeCursor('not-base64-json')).toBeUndefined();
    expect(
      decodeCursor(Buffer.from('{"x":1}').toString('base64url')),
    ).toBeUndefined();
    expect(
      decodeCursor(Buffer.from('{"p":true}').toString('base64url')),
    ).toBeUndefined();
  });
});
