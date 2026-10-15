import { HttpException } from '@nestjs/common';

/** 에러 종류. 클라이언트는 type으로 분기한다 (ADR-0019). */
export const ProblemType = {
  VALIDATION_FAILED: '/problems/validation-failed',
  BAD_REQUEST: '/problems/bad-request',
  UNAUTHORIZED: '/problems/unauthorized',
  NOT_FOUND: '/problems/not-found',
  INVALID_STATE: '/problems/invalid-state',
  INTERNAL_ERROR: '/problems/internal-error',
  SERVICE_UNAVAILABLE: '/problems/service-unavailable',
} as const;
export type ProblemType = (typeof ProblemType)[keyof typeof ProblemType];

export interface FieldError {
  field: string;
  message: string;
}

export interface Problem {
  type: ProblemType;
  title: string;
  detail?: string;
  /** 표준이 허용하는 확장 필드. 필요한 곳에만 붙인다. */
  extensions?: Record<string, unknown>;
}

export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly problem: Problem,
  ) {
    super(problem.detail ?? problem.title, status);
  }
}

export function validationFailed(errors: FieldError[]): ProblemException {
  return new ProblemException(400, {
    type: ProblemType.VALIDATION_FAILED,
    title: 'Invalid request',
    detail: 'One or more fields failed validation',
    extensions: { errors },
  });
}

export function badRequest(detail: string): ProblemException {
  return new ProblemException(400, {
    type: ProblemType.BAD_REQUEST,
    title: 'Bad request',
    detail,
  });
}

export function notFound(detail: string): ProblemException {
  return new ProblemException(404, {
    type: ProblemType.NOT_FOUND,
    title: 'Not found',
    detail,
  });
}

export function invalidState(
  detail: string,
  currentStatus: string,
): ProblemException {
  return new ProblemException(409, {
    type: ProblemType.INVALID_STATE,
    title: 'Not allowed in the current state',
    detail,
    extensions: { currentStatus },
  });
}

export function unauthorized(): ProblemException {
  return new ProblemException(401, {
    type: ProblemType.UNAUTHORIZED,
    title: 'Authentication required',
    detail:
      'The Authorization: Bearer <API key> header is missing or the key is wrong',
  });
}
