import { AlarmStatus } from './status';

/**
 * 발송 시작·취소 요청의 결과를 상태로 정한다 (ADR-0016 전이표, ADR-0020 상태 코드).
 * 조건부 UPDATE가 성공했든, 0건이라 현재 상태를 다시 읽었든 같은 함수로 응답을 정한다.
 * - 이미 목표 상태면 성공이다.
 * - 목표 상태로 갈 수 없으면 409다.
 * - 응답 시점에 일이 아직 진행 중이면 202, 끝났으면 200이다.
 */
export type ActionResponse =
  { kind: 'success'; httpStatus: 200 | 202 } | { kind: 'conflict' };

export function sendResponseFor(status: AlarmStatus): ActionResponse {
  switch (status) {
    case AlarmStatus.SENDING:
      return { kind: 'success', httpStatus: 202 };
    case AlarmStatus.COMPLETED:
      return { kind: 'success', httpStatus: 200 };
    case AlarmStatus.CANCELING:
    case AlarmStatus.CANCELED:
      return { kind: 'conflict' };
    case AlarmStatus.CREATED:
      // 전이가 성공했다면 CREATED로 남을 수 없다. 여기에 오면 호출 순서가 잘못된 것이다.
      throw new Error('Cannot decide a send response for a CREATED alarm');
  }
}

export function cancelResponseFor(status: AlarmStatus): ActionResponse {
  switch (status) {
    case AlarmStatus.CANCELING:
      return { kind: 'success', httpStatus: 202 };
    case AlarmStatus.CANCELED:
      return { kind: 'success', httpStatus: 200 };
    case AlarmStatus.COMPLETED:
      return { kind: 'conflict' };
    case AlarmStatus.CREATED:
    case AlarmStatus.SENDING:
      throw new Error(`Cannot decide a cancel response for a ${status} alarm`);
  }
}
