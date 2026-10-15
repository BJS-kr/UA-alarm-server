import { ValidationError, ValidationPipe } from '@nestjs/common';
import { FieldError, validationFailed } from '../errors/problem';

/**
 * 모르는 필드는 거절한다 (ADR-0021). `recipientIDs` 같은 오타를 조용히 무시하면
 * 클라이언트는 수신자를 지정했다고 믿는데 서버는 지정이 없는 요청으로 처리한다.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) => validationFailed(flatten(errors)),
  });
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flatten(error.children ?? [], field)];
  });
}
