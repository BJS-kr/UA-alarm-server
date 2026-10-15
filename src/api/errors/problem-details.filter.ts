import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { currentTraceId } from '../../shared/logging/log-context';
import { Problem, ProblemException, ProblemType } from './problem';

/**
 * 모든 에러를 RFC 9457 Problem Details로 응답한다 (ADR-0019).
 * 500에는 내부 정보를 담지 않고 traceId만 준다. 상세는 로그에 남긴다.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetails');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { status, problem } = this.toProblem(exception);

    if (status >= 500) {
      this.logger.error('처리하지 못한 오류', exception instanceof Error ? exception : String(exception));
    }
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');

    res
      .status(status)
      .type('application/problem+json')
      .send(
        JSON.stringify({
          type: problem.type,
          title: problem.title,
          status,
          ...(problem.detail ? { detail: problem.detail } : {}),
          instance: req.originalUrl,
          ...problem.extensions,
          traceId: currentTraceId(),
        }),
      );
  }

  private toProblem(exception: unknown): { status: number; problem: Problem } {
    if (exception instanceof ProblemException) {
      return { status: exception.getStatus(), problem: exception.problem };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const detail = exception.message;
      if (status === 404) return { status, problem: { type: ProblemType.NOT_FOUND, title: '대상을 찾을 수 없다', detail } };
      if (status < 500) return { status, problem: { type: ProblemType.BAD_REQUEST, title: '잘못된 요청', detail } };
      return { status, problem: { type: ProblemType.INTERNAL_ERROR, title: '서버 오류' } };
    }
    if (isDatabaseUnavailable(exception)) {
      return {
        status: 503,
        problem: { type: ProblemType.SERVICE_UNAVAILABLE, title: '잠시 처리할 수 없다', detail: '잠시 후 다시 시도한다' },
      };
    }
    return { status: 500, problem: { type: ProblemType.INTERNAL_ERROR, title: '서버 오류' } };
  }
}

/** DB에 연결할 수 없는 경우 (ADR-0020: 503). */
function isDatabaseUnavailable(exception: unknown): boolean {
  const code = (exception as { code?: unknown })?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === '57P01' || // admin_shutdown
    code === '57P03' || // cannot_connect_now
    (exception instanceof Error && /timeout exceeded when trying to connect/i.test(exception.message))
  );
}
