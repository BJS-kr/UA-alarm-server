import { LoggerService } from '@nestjs/common';
import { Counter } from 'prom-client';

/** 어디서도 받지 않고 프로세스까지 올라온 오류의 수. 늘면 버그다. api와 worker가 각자 레지스트리에 등록한다. */
export const unhandledErrors = new Counter({
  name: 'alarm_unhandled_errors_total',
  help: '처리되지 않고 프로세스까지 올라온 오류 수. 1 이상이면 버그이므로 로그를 확인한다',
  labelNames: ['kind'] as const,
  registers: [],
});

/**
 * 처리되지 않은 Promise 거절과 예외를 프로세스 단위로 받는다 (ADR-0039).
 * 로그와 메트릭으로 남기고 프로세스는 계속 돈다. 계속 돌 수 없을 만큼 망가졌다면 생존 확인(ADR-0026)이 잡아 재시작한다.
 * 일부러 끝내야 하는 경우(워커가 잠금을 잃음, ADR-0004)는 이 경로가 아니라 명시적인 종료 함수를 거친다.
 */
export function installProcessGuardrail(logger: LoggerService): void {
  process.on('unhandledRejection', (reason) => {
    unhandledErrors.inc({ kind: 'unhandled_rejection' });
    logger.error('Unhandled promise rejection', toError(reason));
  });
  process.on('uncaughtException', (error) => {
    unhandledErrors.inc({ kind: 'uncaught_exception' });
    logger.error('Uncaught exception', error);
  });
}

/** Error가 아닌 값으로 거절된 경우에도 로그에 내용이 남도록 Error로 감싼다. */
export function toError(reason: unknown): Error {
  const isError = reason instanceof Error;
  if (isError) return reason;

  return new Error(
    typeof reason === 'string'
      ? reason
      : (JSON.stringify(reason) ?? String(reason)),
  );
}
