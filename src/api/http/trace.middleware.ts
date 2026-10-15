import { LoggerService } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logContext } from '../../shared/logging/log-context';

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;

/** W3C traceparent의 trace-id를 이어 쓰고, 없으면 16바이트 무작위 값을 만든다 (ADR-0019). */
export function traceIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? TRACEPARENT.exec(value.trim().toLowerCase()) : null;
  if (match && !/^0+$/.test(match[1])) return match[1];
  return randomBytes(16).toString('hex');
}

/** 요청마다 추적 ID를 맥락에 넣고, 끝나면 요청 한 줄을 info로 남긴다 (ADR-0028). */
export function traceMiddleware(logger: LoggerService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const traceId = traceIdFrom(req.headers.traceparent);
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      logger.log('요청 처리', {
        traceId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });
    });
    logContext.run({ traceId }, () => next());
  };
}
