import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
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

    const isServerFault = status >= 500;
    if (isServerFault) {
      this.logger.error(
        'Unhandled error while handling a request',
        exception instanceof Error ? exception : String(exception),
      );
    }

    const isUnauthorized = status === 401;
    if (isUnauthorized) res.setHeader('WWW-Authenticate', 'Bearer');

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
    const isProblem = exception instanceof ProblemException;
    if (isProblem) {
      return { status: exception.getStatus(), problem: exception.problem };
    }

    // Nest가 직접 던지는 오류(없는 경로, 잘못된 JSON 등)
    const isFrameworkError = exception instanceof HttpException;
    if (isFrameworkError) {
      const status = exception.getStatus();
      const detail = exception.message;
      const isNotFound = status === 404;
      if (isNotFound) {
        return {
          status,
          problem: { type: ProblemType.NOT_FOUND, title: 'Not found', detail },
        };
      }

      const isClientError = status < 500;
      if (isClientError) {
        return {
          status,
          problem: {
            type: ProblemType.BAD_REQUEST,
            title: 'Bad request',
            detail,
          },
        };
      }

      return {
        status,
        problem: {
          type: ProblemType.INTERNAL_ERROR,
          title: 'Internal server error',
        },
      };
    }

    const isUnavailable = isDatabaseUnavailable(exception);
    if (isUnavailable) {
      return {
        status: 503,
        problem: {
          type: ProblemType.SERVICE_UNAVAILABLE,
          title: 'Service temporarily unavailable',
          detail: 'Try again later',
        },
      };
    }

    return {
      status: 500,
      problem: {
        type: ProblemType.INTERNAL_ERROR,
        title: 'Internal server error',
      },
    };
  }
}

/**
 * DB에 연결할 수 없거나 정해 둔 시간 안에 답이 없는 경우 (ADR-0020: 503, ADR-0039).
 * Drizzle은 드라이버 오류를 "Failed query"로 감싸 cause에 두므로 cause를 따라가며 본다.
 */
function isDatabaseUnavailable(exception: unknown): boolean {
  return causesOf(exception).some((error) => {
    const code = (error as { code?: unknown })?.code;

    return (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === '57P01' || // admin_shutdown
      code === '57P03' || // cannot_connect_now
      (error instanceof Error &&
        /timeout exceeded when trying to connect|query read timeout/i.test(
          error.message,
        ))
    );
  });
}

/** 오류와 그 cause들. 순환을 막으려고 깊이를 제한한다. */
function causesOf(exception: unknown, maxDepth = 5): unknown[] {
  const chain: unknown[] = [];
  let current = exception;

  while (current !== undefined && current !== null && chain.length < maxDepth) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }

  return chain;
}
