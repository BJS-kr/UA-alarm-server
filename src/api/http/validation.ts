import { ValidationError, ValidationPipe } from '@nestjs/common';
import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';
import { FieldError, validationFailed } from '../errors/problem';

/**
 * 글자 수를 코드 포인트로 센다. DB의 CHECK(char_length)와 같은 기준이다 (ADR-0021).
 * class-validator의 Length는 이모지 변형 선택자(U+FE0F 등)를 빼고 세서, 통과한 값이 DB에서 거절되어 500이 된다.
 */
export function CharLength(
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'charLength',
      constraints: [min, max],
      validator: {
        validate: (value: unknown) => {
          const isText = typeof value === 'string';
          if (!isText) return false;
          const length = [...value].length;

          return length >= min && length <= max;
        },
        defaultMessage: buildMessage(
          (each) =>
            `${each}$property must be between ${min} and ${max} characters`,
          options,
        ),
      },
    },
    options,
  );
}

/** Postgres의 text는 NUL(U+0000)을 담지 못한다. 받아 두면 저장할 때 500이 되므로 입력에서 거절한다. */
export function NoNulCharacter(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'noNulCharacter',
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'string' || !value.includes('\u0000'),
        defaultMessage: buildMessage(
          (each) => `${each}$property must not contain NUL characters`,
          options,
        ),
      },
    },
    options,
  );
}

/**
 * 모르는 필드는 거절한다 (ADR-0021). `recipientIDs` 같은 오타를 조용히 무시하면
 * 클라이언트는 수신자를 지정했다고 믿는데 서버는 지정이 없는 요청으로 처리한다.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      validationFailed(flatten(errors)),
  });
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => ({
      field,
      message,
    }));

    return [...own, ...flatten(error.children ?? [], field)];
  });
}
