import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import {
  traceIdFrom,
  traceMiddleware,
} from '../../../src/api/http/trace.middleware';
import { loadConfig } from '../../../src/shared/config/app-config';
import {
  cancelResponseFor,
  sendResponseFor,
} from '../../../src/shared/domain/alarm-actions';
import { decodeCursor } from '../../../src/shared/domain/cursor';
import {
  decideAfterLookup,
  decideAfterSend,
} from '../../../src/shared/domain/send-outcome';
import { AlarmStatus } from '../../../src/shared/domain/status';
import { logContext } from '../../../src/shared/logging/log-context';
import {
  maskError,
  maskSensitive,
  maskStack,
  maskUrlCredentials,
} from '../../../src/shared/logging/masking';

/** 변이 테스팅에서 살아남은 변이를 보고 보강한 경계 조건들 (ADR-0034 2층). */
const base = {
  DATABASE_URL: 'postgres://alarm_app:secret@db:5432/alarm',
  API_KEY: 'k',
};

describe('설정 관계의 경계값 (ADR-0030)', () => {
  it('생존 신호와 발송 직전 확인이 같으면 거부한다(엄격히 작아야 한다)', () => {
    expect(() =>
      loadConfig(
        { ...base, HEARTBEAT_INTERVAL_MS: '5000', SEND_GUARD_MS: '5000' },
        'worker',
      ),
    ).toThrow(/HEARTBEAT_INTERVAL_MS/);
  });

  it('발송 직전 확인과 무효 선언이 같으면 거부한다', () => {
    expect(() =>
      loadConfig(
        { ...base, SEND_GUARD_MS: '15000', INVALIDATE_AFTER_MS: '15000' },
        'worker',
      ),
    ).toThrow(/INVALIDATE_AFTER_MS/);
  });

  it('한 번에 꺼내는 수가 동시 발송 한도와 같은 것은 허용한다', () => {
    expect(
      loadConfig(
        { ...base, CLAIM_BATCH_MAX: '50', MAX_IN_FLIGHT: '50' },
        'worker',
      ).CLAIM_BATCH_MAX,
    ).toBe(50);
  });

  it('재시도 시작 간격이 최대 간격보다 크면 거부하고, 같으면 허용한다', () => {
    expect(() =>
      loadConfig(
        { ...base, RETRY_BASE_MS: '2000', RETRY_MAX_MS: '1000' },
        'worker',
      ),
    ).toThrow(/RETRY_BASE_MS/);
    expect(
      loadConfig(
        { ...base, RETRY_BASE_MS: '1000', RETRY_MAX_MS: '1000' },
        'worker',
      ).RETRY_MAX_MS,
    ).toBe(1000);
  });

  it('브레이커 최소 정지가 최대보다 크면 거부하고, 같으면 허용한다', () => {
    expect(() =>
      loadConfig(
        { ...base, BREAKER_PAUSE_MIN_MS: '9000', BREAKER_PAUSE_MAX_MS: '8000' },
        'worker',
      ),
    ).toThrow(/BREAKER_PAUSE_MIN_MS/);
    expect(
      loadConfig(
        { ...base, BREAKER_PAUSE_MIN_MS: '8000', BREAKER_PAUSE_MAX_MS: '8000' },
        'worker',
      ).BREAKER_PAUSE_MIN_MS,
    ).toBe(8000);
  });

  it('migrate는 앱 계정 주소 없이 마이그레이션 계정 주소만 있으면 된다', () => {
    expect(
      loadConfig(
        { MIGRATION_DATABASE_URL: 'postgres://m:p@db/alarm' },
        'migrate',
      ).DATABASE_URL,
    ).toBeUndefined();
  });

  it('빈 문자열 값은 없는 값으로 보고 기본값을 쓴다', () => {
    expect(
      loadConfig({ ...base, RATE_LIMIT_PER_SEC: '' }, 'worker')
        .RATE_LIMIT_PER_SEC,
    ).toBe(50);
  });

  it('틀린 값이 여럿이면 한 줄에 하나씩 모두 알린다', () => {
    try {
      loadConfig({ MAX_IN_FLIGHT: 'x', LOG_LEVEL: 'loud' }, 'worker');
      throw new Error('예외가 나야 한다');
    } catch (error) {
      const lines = (error as Error).message.split('\n - ');

      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines.some((l) => l.startsWith('MAX_IN_FLIGHT'))).toBe(true);
      expect(lines.some((l) => l.startsWith('LOG_LEVEL'))).toBe(true);
      expect(lines.some((l) => l.startsWith('DATABASE_URL'))).toBe(true);
    }
  });
});

describe('마스킹 규칙 (ADR-0028)', () => {
  it('비밀 키는 대소문자와 관계없이 전부 가린다', () => {
    const masked = maskSensitive({
      password: 'p',
      ApiKey: 'k',
      api_key: 'k',
      Authorization: 'Bearer x',
      secret: 's',
      token: 't',
    });

    expect(Object.values(masked as object)).toEqual(Array(6).fill('****'));
  });

  it('접속 주소는 비밀번호만 가린다', () => {
    expect(maskUrlCredentials('postgres://alarm_app:pw@db:5432/alarm')).toBe(
      'postgres://alarm_app:****@db:5432/alarm',
    );
    expect(
      maskSensitive({
        DATABASE_URL: 'postgres://a:b@h/d',
        migration_database_url: 'postgres://m:n@h/d',
        databaseUrl: 'postgres://c:d@h/e',
      }),
    ).toEqual({
      DATABASE_URL: 'postgres://a:****@h/d',
      migration_database_url: 'postgres://m:****@h/d',
      databaseUrl: 'postgres://c:****@h/e',
    });
  });

  it('접속 주소의 비밀번호는 필드 이름과 관계없이 가린다', () => {
    expect(
      maskSensitive({ note: 'connect postgres://a:b@h/d', name: '이유찬' }),
    ).toEqual({ note: 'connect postgres://a:****@h/d', name: '이유찬' });
  });

  it('전화번호 모양이 아닌 값은 바꾸지 않는다', () => {
    expect(maskSensitive({ phone: 'tel:010-1234-5678' })).toEqual({
      phone: 'tel:010-1234-5678',
    });
    expect(maskSensitive({ phone: '010-1234-5678 ext' })).toEqual({
      phone: '010-1234-5678 ext',
    });
  });

  it('순환 참조가 있어도 끝없이 내려가지 않는다', () => {
    const node: Record<string, unknown> = { body: '1234' };

    node.self = node;
    expect(() => maskSensitive(node)).not.toThrow();
    expect((maskSensitive(node) as { body: string }).body).toBe('****');
    const list: unknown[] = [{ body: '5678' }];

    list.push(list);
    expect(() => maskSensitive(list)).not.toThrow();
    expect((maskSensitive(list) as Array<{ body: string }>)[0].body).toBe(
      '****',
    );
  });

  it('문자열이 아닌 값은 그대로 두고, Error는 글을 가린 일반 객체로 바꾼다', () => {
    const error = new Error('code 1234');

    expect(maskSensitive({ body: 1234, token: null, nested: error })).toEqual({
      body: 1234,
      token: null,
      nested: expect.objectContaining({ name: 'Error', message: 'code ****' }),
    });
    expect(maskSensitive(error)).not.toBeInstanceOf(Error);
    expect(maskSensitive('본문 1234')).toBe('본문 1234');
  });
});

describe('오류 마스킹의 경계 (ADR-0028)', () => {
  it('오류 종류를 나타내는 필드는 숫자가 있어도 그대로 두고, 비밀 키는 가린다', () => {
    const error = Object.assign(new Error('x'), {
      code: '23505',
      errno: '1234',
      syscall: 'connect6000',
      severity: 'ERROR0000',
      detail: 'row (482913)',
      token: 'abc',
    });

    expect(maskError(error)).toMatchObject({
      code: '23505',
      errno: '1234',
      syscall: 'connect6000',
      severity: 'ERROR0000',
      detail: 'row (******)',
      token: '****',
    });
  });

  it('원시값이 아닌 필드는 옮기지 않는다 (바인딩 값 배열 등)', () => {
    const error = Object.assign(new Error('x'), { params: ['482913'] });

    expect(maskError(error)).not.toHaveProperty('params');
  });

  it('Error가 아닌 cause도 가린다', () => {
    const text = maskError(new Error('x', { cause: 'otp 482913' }));
    const object = maskError(new Error('x', { cause: { body: '1234' } }));

    expect(text.cause).toBe('otp ******');
    expect(object.cause).toEqual({ body: '****' });
  });

  it('AggregateError의 오류들도 가린다', () => {
    const error = new AggregateError([new Error('otp 482913')], 'many');

    expect(
      (maskError(error).errors as Array<{ message: string }>)[0].message,
    ).toBe('otp ******');
  });

  it('cause가 순환하거나 너무 깊으면 멈춘다', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });

    a.cause = b;
    expect((maskError(a).cause as { cause: unknown }).cause).toBe('[Circular]');

    let deep = new Error('0');

    for (let i = 1; i <= 7; i++) deep = new Error(String(i), { cause: deep });
    let level: Record<string, unknown> = maskError(deep);
    let depth = 0;

    while (typeof level.cause === 'object') {
      level = level.cause as Record<string, unknown>;
      depth++;
    }

    expect(depth).toBe(5);
    expect(level.cause).toBe('[Truncated]');
  });

  it('스택의 호출 위치 줄은 그대로 두고 메시지 줄만 가린다', () => {
    const stack = 'Error: otp 482913\n    at f (/app/dist/x.js:1234:56)';

    expect(maskStack(stack)).toBe(
      'Error: otp ******\n    at f (/app/dist/x.js:1234:56)',
    );
  });
});

describe('추적 ID 파싱의 경계 (ADR-0019)', () => {
  const id = '4bf92f3577b34da6a3ce929d0e0e4736';

  it('앞뒤 공백과 대문자는 정리해서 받는다', () => {
    expect(traceIdFrom(`  00-${id.toUpperCase()}-00f067aa0ba902b7-01  `)).toBe(
      id,
    );
  });

  it('앞이나 뒤에 다른 문자가 붙으면 받지 않는다', () => {
    expect(traceIdFrom(`x00-${id}-00f067aa0ba902b7-01`)).not.toBe(id);
    expect(traceIdFrom(`00-${id}-00f067aa0ba902b7-01x`)).not.toBe(id);
  });

  it('0으로만 된 ID만 거절하고, 일부가 0인 ID는 받는다', () => {
    const partial = `00000000000000000000000000000001`;

    expect(traceIdFrom(`00-${partial}-00f067aa0ba902b7-01`)).toBe(partial);
    const leadingNonZero = `10000000000000000000000000000000`;

    expect(traceIdFrom(`00-${leadingNonZero}-00f067aa0ba902b7-01`)).toBe(
      leadingNonZero,
    );
  });

  it('미들웨어는 다음 처리를 추적 ID 맥락 안에서 부르고, 끝나면 요청 한 줄을 남긴다', () => {
    const logs: Array<{ message: string; fields: Record<string, unknown> }> =
      [];
    const logger = {
      log: (message: string, fields: Record<string, unknown>) =>
        logs.push({ message, fields }),
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 201 });
    const req = {
      headers: { traceparent: `00-${id}-00f067aa0ba902b7-01` },
      method: 'POST',
      originalUrl: '/v1/alarms',
    };
    let seen: string | undefined;
    const next: NextFunction = () => {
      seen = logContext.getStore()?.traceId;
    };

    traceMiddleware(logger as never)(
      req as unknown as Request,
      res as unknown as Response,
      next,
    );
    expect(seen).toBe(id);
    expect(logs).toHaveLength(0);
    res.emit('finish');
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe('Request handled');
    expect(logs[0].fields).toMatchObject({
      traceId: id,
      method: 'POST',
      path: '/v1/alarms',
      status: 201,
    });
    expect(logs[0].fields.durationMs).toBeGreaterThanOrEqual(0);
    expect(logs[0].fields.durationMs).toBeLessThan(1000);
  });
});

describe('도메인 결과의 세부 값', () => {
  const options = {
    baseMs: 1000,
    maxMs: 60_000,
    jitterRatio: 0,
    maxAttempts: 8,
  };

  it('429 결정은 코드와 대기 시간을 남긴다', () => {
    expect(
      decideAfterSend({ kind: 'rate_limited', retryAfterSec: 2 }, 1, options),
    ).toEqual({
      kind: 'requeue_uncounted',
      code: 'RATE_LIMITED',
      message: 'retry-after 2s',
    });
  });

  it('재시도를 다 쓴 실패는 원래 메시지와 횟수를 남긴다', () => {
    const decision = decideAfterSend(
      {
        kind: 'server_error',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'down',
      },
      8,
      options,
    );

    expect(decision).toEqual({
      kind: 'failed',
      code: 'SERVICE_UNAVAILABLE',
      message: 'down (gave up after 8 attempts)',
    });
    const lookup = decideAfterLookup(
      { kind: 'ok', messages: [] },
      false,
      { attempts: 8, lookupFailures: 0 },
      options,
    );

    expect(lookup).toEqual({
      kind: 'failed',
      code: 'NOT_DELIVERED',
      message: 'No send record found (gave up after 8 attempts)',
    });
  });

  it('응답을 정할 수 없는 상태는 그 상태를 담아 알린다', () => {
    expect(() => sendResponseFor(AlarmStatus.CREATED)).toThrow(/CREATED/);
    expect(() => cancelResponseFor(AlarmStatus.SENDING)).toThrow(/SENDING/);
  });

  it('JSON이지만 커서 모양이 아니면 undefined다', () => {
    for (const value of ['null', '[1]', '"p"', '42', '{"p":null}']) {
      expect(
        decodeCursor(Buffer.from(value).toString('base64url')),
      ).toBeUndefined();
    }
  });
});
