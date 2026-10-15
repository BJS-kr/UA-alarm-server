import { AsyncLocalStorage } from 'node:async_hooks';

/** 로그 줄마다 자동으로 붙는 맥락 (ADR-0019, 0028). */
export interface LogContext {
  traceId?: string;
  workerId?: string;
  alarmId?: string;
  deliveryId?: string;
  attempt?: number;
}

export const logContext = new AsyncLocalStorage<LogContext>();

/** 현재 맥락에 필드를 더해 fn을 실행한다. 바깥 맥락은 바뀌지 않는다. */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return logContext.run({ ...logContext.getStore(), ...fields }, fn);
}

export function currentTraceId(): string | undefined {
  return logContext.getStore()?.traceId;
}
