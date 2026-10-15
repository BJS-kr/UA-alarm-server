import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { logContext } from './log-context';
import { maskSensitive } from './masking';

export function logLevelsFor(level: 'info' | 'debug'): LogLevel[] {
  return level === 'debug' ? ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'] : ['fatal', 'error', 'warn', 'log'];
}

interface JsonLogOptions {
  context: string;
  logLevel: LogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
  params?: Record<string, any>;
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
    super(context ?? 'App', { json: true, logLevels: logLevelsFor(level), flattenParams: true });
  }

  protected getJsonLogObject(message: unknown, options: JsonLogOptions): JsonLogObject {
    const masked: JsonLogOptions = {
      ...options,
      params: options.params ? (maskSensitive(options.params) as Record<string, unknown>) : undefined,
    };
    const logObject = super.getJsonLogObject(maskSensitive(message), masked) as JsonLogObject;
    const ctx = logContext.getStore();
    if (ctx) {
      for (const [key, value] of Object.entries(ctx)) {
        if (value !== undefined && !(key in logObject)) logObject[key] = value;
      }
    }
    return logObject;
  }
}
