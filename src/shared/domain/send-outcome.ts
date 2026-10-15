import { BackoffOptions, retryDelayMs } from './retry-policy';

/**
 * 외부 발송 요청 한 번의 결과. "보냈는지 모르는" 경우를 따로 구분한다 (ADR-0002, 0037).
 * - not_sent: 연결 단계에서 실패해 요청이 나가지 않았다.
 * - unknown: 요청을 쓴 뒤에 실패했다(타임아웃, 응답 도중 끊김, 게이트웨이 오류).
 */
export type SendResult =
  | { kind: 'accepted'; messageId: string }
  | { kind: 'rejected'; status: number; code: string; message: string }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'server_error'; status: number; code: string; message: string }
  | { kind: 'not_sent'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string };

/** 발송 결과를 받은 IN_FLIGHT Delivery가 갈 곳 (ADR-0014, 0032). */
export type SendDecision =
  | { kind: 'sent'; messageId: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'retry'; delayMs: number; code: string; message: string }
  | { kind: 'requeue_uncounted'; code: string; message: string }
  | { kind: 'unconfirmed'; code: string; message: string };

export interface RetryOptions extends BackoffOptions {
  maxAttempts: number;
}

export function decideAfterSend(
  result: SendResult,
  attempts: number,
  options: RetryOptions,
  random: () => number = Math.random,
): SendDecision {
  switch (result.kind) {
    case 'accepted':
      return { kind: 'sent', messageId: result.messageId };
    case 'rejected':
      // 400은 영구 실패다. 재시도해도 결과가 같다.
      return { kind: 'failed', code: result.code, message: result.message };
    case 'rate_limited':
      // 그 건의 문제가 아니라 우리 속도의 문제이므로 시도 횟수에 세지 않는다.
      return {
        kind: 'requeue_uncounted',
        code: 'RATE_LIMITED',
        message: `retry-after ${result.retryAfterSec}s`,
      };
    case 'server_error':
    case 'not_sent': {
      const isOutOfAttempts = attempts >= options.maxAttempts;
      if (isOutOfAttempts) {
        return {
          kind: 'failed',
          code: result.code,
          message: `${result.message} (gave up after ${attempts} attempts)`,
        };
      }

      return {
        kind: 'retry',
        delayMs: retryDelayMs(attempts, options, random),
        code: result.code,
        message: result.message,
      };
    }
    case 'unknown':
      return {
        kind: 'unconfirmed',
        code: result.code,
        message: result.message,
      };
  }
}

/** 서킷 브레이커가 장애 신호로 세는 결과: 5xx, 연결 오류, 타임아웃 (ADR-0014). */
export function isBreakerFailure(result: SendResult): boolean {
  return (
    result.kind === 'server_error' ||
    result.kind === 'not_sent' ||
    result.kind === 'unknown'
  );
}

export interface LookedUpMessage {
  messageId: string;
  recipientId: string;
  sentAt: string;
}

export type LookupResult =
  | { kind: 'ok'; messages: LookedUpMessage[] }
  | { kind: 'error'; code: string; message: string };

/** 결과 확인을 마친 UNCONFIRMED Delivery가 갈 곳 (ADR-0002, 0017, 0032). */
export type ReconcileDecision =
  | { kind: 'sent'; messageId: string; sentAt: string; duplicate: boolean }
  | { kind: 'canceled' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'resend' }
  | { kind: 'retry_lookup'; delayMs: number };

/** 결과 확인 대상 Delivery의 진행 상황. lookupFailures는 이번 결과 미확정 동안 연달아 실패한 조회 수다. */
export interface LookupProgress {
  attempts: number;
  lookupFailures: number;
}

export function decideAfterLookup(
  lookup: LookupResult,
  isAlarmCanceling: boolean,
  { attempts, lookupFailures }: LookupProgress,
  options: RetryOptions,
  random: () => number = Math.random,
): ReconcileDecision {
  const isLookupFailed = lookup.kind === 'error';
  if (isLookupFailed) {
    // 조회가 실패하면 다시 보내지 않고 조회만 다시 한다. 발송 시도 횟수에는 세지 않고, 간격은 발송 재시도와 같이 늘린다 (ADR-0014).
    return {
      kind: 'retry_lookup',
      delayMs: retryDelayMs(lookupFailures + 1, options, random),
    };
  }

  const isRecorded = lookup.messages.length > 0;
  if (isRecorded) {
    const first = lookup.messages[0];

    return {
      kind: 'sent',
      messageId: first.messageId,
      sentAt: first.sentAt,
      duplicate: lookup.messages.length > 1,
    };
  }

  // 기록 없음이 확인됐다. 이전 시도는 나가지 않았다.
  if (isAlarmCanceling) return { kind: 'canceled' };
  const isOutOfAttempts = attempts >= options.maxAttempts;
  if (isOutOfAttempts) {
    return {
      kind: 'failed',
      code: 'NOT_DELIVERED',
      message: `No send record found (gave up after ${attempts} attempts)`,
    };
  }

  return { kind: 'resend' };
}
