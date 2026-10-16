import { BackoffOptions, retryDelayMs } from './retry-policy';

/**
 * 단건 외부 발송 요청의 결과 분류. 전송 여부 미확정(unknown) 상태를 별도로 구분한다 (ADR-0002, 0037).
 * - not_sent: 커넥션 수립 단계에서 실패하여 요청 바이트가 전송되지 않음.
 * - withheld: 소켓 쓰기 직전 가드 검증 실패로 발송을 보류함 (ADR-0004).
 * - unknown: 요청 전송 이후 응답을 받지 못함 (타임아웃, 연결 유실, 502/503/504 등).
 */
export type SendResult =
  | { kind: 'accepted'; messageId: string }
  | { kind: 'rejected'; status: number; code: string; message: string }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'server_error'; status: number; code: string; message: string }
  | { kind: 'not_sent'; code: string; message: string }
  | { kind: 'withheld' }
  | { kind: 'unknown'; code: string; message: string };

/** 발송 결과에 따른 IN_FLIGHT Delivery의 후속 상태 결정 (ADR-0014, 0032). */
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
 * isOutage: 서킷 브레이커 OPEN(외부 장애) 여부. 장애 구간의 5xx·연결 오류·타임아웃은 개별 건의 결함이 아니므로
 * 시도 횟수(attempts)에서 차감하여 장애 장기화 시 재시도 소진으로 인한 누락을 방지한다 (ADR-0014).
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
      // 400 응답은 비재시도성 영구 실패로 처리한다.
      return { kind: 'failed', code: result.code, message: result.message };
    case 'rate_limited':
      // 처리량 제한(429)은 시도 횟수에 포함하지 않고 재큐잉한다.
      return {
        kind: 'requeue_uncounted',
        code: 'RATE_LIMITED',
        message: `retry-after ${result.retryAfterSec}s`,
      };
    case 'withheld':
      // 전송 전 가드에서 보류된 건이므로 시도 횟수를 차감하고 반납한다.
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

/** 장애 구간 실패 처리. 전송 여부 미확정(unknown) 건은 발송 내역 조회를 위해 UNCONFIRMED로 전이하되 시도 횟수만 차감한다. */
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

/** 서킷 브레이커가 집계하는 장애 결과 유형: 5xx, 연결 오류, 타임아웃 (ADR-0014). */
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

/** 발송 내역 조회(상태 확정) 이후 UNCONFIRMED Delivery의 후속 상태 결정 (ADR-0002, 0017, 0032). */
export type ReconcileDecision =
  | { kind: 'sent'; messageId: string; sentAt: string; duplicate: boolean }
  | { kind: 'canceled' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'resend' }
  | { kind: 'retry_lookup'; delayMs: number };

/** 상태 확정 대상 Delivery의 진행 상태. lookupFailures는 현재 UNCONFIRMED 상태에서 연속 실패한 조회 횟수다. */
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
