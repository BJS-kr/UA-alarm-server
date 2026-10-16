import { BackoffOptions, retryDelayMs } from './retry-policy';

/**
 * 외부 발송 요청 한 번의 결과. "보냈는지 모르는" 경우를 따로 구분한다 (ADR-0002, 0037).
 * - not_sent: 연결 단계에서 실패해 요청이 나가지 않았다.
 * - withheld: 쓰기 직전 확인에 걸려 우리가 보내지 않았다. 외부 서비스와는 관계없다 (ADR-0004).
 * - unknown: 요청을 쓴 뒤에 실패했다(타임아웃, 응답 도중 끊김, 게이트웨이 오류).
 */
export type SendResult =
  | { kind: 'accepted'; messageId: string }
  | { kind: 'rejected'; status: number; code: string; message: string }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'server_error'; status: number; code: string; message: string }
  | { kind: 'not_sent'; code: string; message: string }
  | { kind: 'withheld' }
  | { kind: 'unknown'; code: string; message: string };

/** 발송 결과를 받은 IN_FLIGHT Delivery가 갈 곳 (ADR-0014, 0032). */
export type SendDecision =
  | { kind: 'sent'; messageId: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'retry'; delayMs: number; code: string; message: string }
  | { kind: 'requeue_uncounted'; code: string; message: string }
  | { kind: 'unconfirmed'; code: string; message: string; uncounted?: true };

export interface RetryOptions extends BackoffOptions {
  maxAttempts: number;
}

/**
 * isOutage: 서킷 브레이커가 장애로 판단한 상태(열림)다. 이 동안의 5xx·연결 오류·응답 없음은 그 건이 아니라 외부 장애 탓이므로
 * 시도 횟수에 세지 않는다. 그래야 장애가 길어져도 재시도를 다 써서 누락되는 건이 없다 (ADR-0014).
 */
export function decideAfterSend(
  result: SendResult,
  attempts: number,
  options: RetryOptions,
  random: () => number = Math.random,
  isOutage = false,
): SendDecision {
  const isOutageFailure = isOutage && isBreakerFailure(result);
  if (isOutageFailure) return outageDecision(result);

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
    case 'withheld':
      // 나가지 않았고 그 건의 문제도 아니다. 워커는 이 결과를 꺼낼 때 확인에 걸린 건처럼 반납한다.
      return {
        kind: 'requeue_uncounted',
        code: 'SEND_GUARD',
        message: 'Not sent because the pre-write check failed',
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

/** 장애 동안의 실패. 보냈는지 모르는 건은 조회로 확인해야 하므로 결과 미확정으로 두되 횟수만 되돌린다. */
function outageDecision(result: BreakerFailure): SendDecision {
  const isUnknown = result.kind === 'unknown';
  if (isUnknown) {
    return {
      kind: 'unconfirmed',
      code: result.code,
      message: result.message,
      uncounted: true,
    };
  }

  return {
    kind: 'requeue_uncounted',
    code: result.code,
    message: result.message,
  };
}

type BreakerFailure = Extract<
  SendResult,
  { kind: 'server_error' | 'not_sent' | 'unknown' }
>;

/** 서킷 브레이커가 장애 신호로 세는 결과: 5xx, 연결 오류, 타임아웃 (ADR-0014). */
export function isBreakerFailure(result: SendResult): result is BreakerFailure {
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
