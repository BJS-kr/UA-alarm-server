import {
  decideAfterLookup,
  decideAfterSend,
  isBreakerFailure,
  RetryOptions,
  SendResult,
} from '../../../src/shared/domain/send-outcome';

const options: RetryOptions = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0, maxAttempts: 8 };
const noJitter = () => 0.5;

describe('발송 결과 → Delivery 처리 (ADR-0014, 0032)', () => {
  it('202는 발송 완료다', () => {
    expect(decideAfterSend({ kind: 'accepted', messageId: 'm_1' }, 1, options, noJitter)).toEqual({ kind: 'sent', messageId: 'm_1' });
  });

  it('400은 재시도하지 않는 영구 실패다', () => {
    const result: SendResult = { kind: 'rejected', status: 400, code: 'RECIPIENT_BLOCKED', message: 'opted out' };
    expect(decideAfterSend(result, 1, options, noJitter)).toEqual({ kind: 'failed', code: 'RECIPIENT_BLOCKED', message: 'opted out' });
  });

  it('429는 시도 횟수에 세지 않고 바로 대기열로 돌린다', () => {
    expect(decideAfterSend({ kind: 'rate_limited', retryAfterSec: 1 }, 3, options, noJitter).kind).toBe('requeue_uncounted');
  });

  it('500·503은 백오프 후 재시도한다', () => {
    const result: SendResult = { kind: 'server_error', status: 503, code: 'SERVICE_UNAVAILABLE', message: 'x' };
    expect(decideAfterSend(result, 1, options, noJitter)).toEqual({
      kind: 'retry',
      delayMs: 1000,
      code: 'SERVICE_UNAVAILABLE',
      message: 'x',
    });
    expect(decideAfterSend(result, 3, options, noJitter)).toMatchObject({ kind: 'retry', delayMs: 4000 });
  });

  it('요청이 나가지 못한 연결 오류도 재시도한다', () => {
    expect(decideAfterSend({ kind: 'not_sent', code: 'ECONNREFUSED', message: 'x' }, 1, options, noJitter).kind).toBe('retry');
  });

  it('최대 시도 횟수를 다 쓰면 실패로 확정한다', () => {
    const result: SendResult = { kind: 'server_error', status: 500, code: 'INTERNAL_ERROR', message: 'x' };
    expect(decideAfterSend(result, 7, options, noJitter).kind).toBe('retry');
    expect(decideAfterSend(result, 8, options, noJitter)).toMatchObject({ kind: 'failed', code: 'INTERNAL_ERROR' });
  });

  it('보냈는지 모르면(타임아웃 등) 다시 보내지 않고 결과 미확정으로 둔다', () => {
    const decision = decideAfterSend({ kind: 'unknown', code: 'CLIENT_TIMEOUT', message: 'x' }, 8, options, noJitter);
    expect(decision).toEqual({ kind: 'unconfirmed', code: 'CLIENT_TIMEOUT', message: 'x' });
  });

  it('서킷 브레이커는 5xx, 연결 오류, 타임아웃만 장애 신호로 센다', () => {
    expect(isBreakerFailure({ kind: 'server_error', status: 500, code: 'x', message: 'x' })).toBe(true);
    expect(isBreakerFailure({ kind: 'not_sent', code: 'x', message: 'x' })).toBe(true);
    expect(isBreakerFailure({ kind: 'unknown', code: 'x', message: 'x' })).toBe(true);
    expect(isBreakerFailure({ kind: 'accepted', messageId: 'm' })).toBe(false);
    expect(isBreakerFailure({ kind: 'rejected', status: 400, code: 'x', message: 'x' })).toBe(false);
    expect(isBreakerFailure({ kind: 'rate_limited', retryAfterSec: 1 })).toBe(false);
  });
});

describe('결과 확인 → Delivery 처리 (ADR-0002, 0017)', () => {
  const found = { kind: 'ok' as const, messages: [{ messageId: 'm_1', recipientId: 'u_1', sentAt: '2026-10-15T00:00:00Z' }] };
  const empty = { kind: 'ok' as const, messages: [] };

  it('기록이 있으면 다시 보내지 않고 발송 완료로 확정한다', () => {
    expect(decideAfterLookup(found, false, 2, options, noJitter)).toEqual({
      kind: 'sent',
      messageId: 'm_1',
      sentAt: '2026-10-15T00:00:00Z',
      duplicate: false,
    });
  });

  it('기록이 두 건 이상이면 중복으로 표시한다', () => {
    const twice = { kind: 'ok' as const, messages: [...found.messages, { messageId: 'm_2', recipientId: 'u_1', sentAt: 'x' }] };
    expect(decideAfterLookup(twice, false, 2, options, noJitter)).toMatchObject({ kind: 'sent', duplicate: true });
  });

  it('기록이 없음이 확인되면 다시 보낸다', () => {
    expect(decideAfterLookup(empty, false, 2, options, noJitter)).toEqual({ kind: 'resend' });
  });

  it('기록이 없는데 알림이 취소 중이면 다시 보내지 않고 취소한다', () => {
    expect(decideAfterLookup(empty, true, 2, options, noJitter)).toEqual({ kind: 'canceled' });
  });

  it('기록이 없는데 시도를 다 썼으면 실패로 확정한다', () => {
    expect(decideAfterLookup(empty, false, 8, options, noJitter)).toMatchObject({ kind: 'failed', code: 'NOT_DELIVERED' });
  });

  it('조회 자체가 실패하면 다시 보내지 않고 조회만 다시 한다', () => {
    const decision = decideAfterLookup({ kind: 'error', code: 'HTTP_500', message: 'x' }, false, 8, options, noJitter);
    expect(decision).toEqual({ kind: 'retry_lookup', delayMs: 1000 });
  });
});
