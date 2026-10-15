import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { logContext } from './log-context';
import { maskError, maskFreeText, maskSensitive, maskStack } from './masking';

export function logLevelsFor(level: 'info' | 'debug'): LogLevel[] {
  return level === 'debug'
    ? ['fatal', 'error', 'warn', 'log', 'debug', 'verbose']
    : ['fatal', 'error', 'warn', 'log'];
}

interface JsonLogOptions {
  context: string;
  logLevel: LogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
  params?: Record<string, unknown>;
  error?: Error;
}

interface JsonLogObject {
  [key: string]: unknown;
  level: LogLevel;
  pid: number;
  timestamp: number;
  message: unknown;
}

/**
 * NestJS 기본 로거의 JSON 모드를 얇게 감싼다 (ADR-0028).
 * - 맥락(traceId, workerId, alarmId, deliveryId, attempt)을 모든 줄에 붙인다.
 * - 메시지와 구조화 필드를 마스킹한다.
 */
export class AppLogger extends ConsoleLogger {
  constructor(level: 'info' | 'debug', context?: string) {
    super(context ?? 'App', {
      json: true,
      logLevels: logLevelsFor(level),
      flattenParams: true,
    });
  }

  protected getJsonLogObject(
    message: unknown,
    options: JsonLogOptions,
  ): JsonLogObject {
    // 여러 줄 메시지의 스택은 Nest가 스택으로 알아보지 못해 context 자리에 넣는다. 그래서 context도 스택처럼 가린다.
    const masked: JsonLogOptions = {
      ...options,
      context:
        typeof options.context === 'string'
          ? maskStack(options.context)
          : options.context,
      errorStack:
        typeof options.errorStack === 'string'
          ? maskStack(options.errorStack)
          : options.errorStack,
      params: options.params
        ? (maskSensitive(options.params) as Record<string, unknown>)
        : undefined,
    };
    // 메시지는 우리가 쓴 상수이거나, 오류를 첫 인자로 넘겼을 때 그 오류의 글이다. 뒤의 경우를 위해 숫자를 가린다.
    const logObject = super.getJsonLogObject(
      typeof message === 'string'
        ? maskFreeText(message)
        : maskSensitive(message),
      masked,
    ) as JsonLogObject;
    const ctx = logContext.getStore();
    const isInContext = ctx !== undefined;
    if (isInContext) {
      for (const [key, value] of Object.entries(ctx)) {
        // 줄에 직접 넘긴 값이 맥락 값보다 앞선다.
        const isMissingFromLine = value !== undefined && !(key in logObject);
        if (isMissingFromLine) logObject[key] = value;
      }
    }

    return logObject;
  }

  /** 오류를 넘긴 로그(`logger.error(msg, error)`)의 error 필드. 기본 직렬화는 글을 그대로 옮긴다. */
  protected serializeError(error: Error): Record<string, unknown> {
    return maskError(error);
  }
}
