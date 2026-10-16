import { traceIdFrom } from '../../../src/api/http/trace.middleware';
import {
  describeConfig,
  loadConfig,
} from '../../../src/shared/config/app-config';
import { AppLogger } from '../../../src/shared/logging/app-logger';
import {
  maskDigits,
  maskPhone,
  maskSensitive,
} from '../../../src/shared/logging/masking';

const base = {
  DATABASE_URL: 'postgres://alarm_app:secret@db:5432/alarm',
  API_KEY: 'k',
};

describe('설정 검증 (ADR-0030)', () => {
  it('기본값은 지금까지의 결정값이다', () => {
    const config = loadConfig(base, 'api');

    expect(config.RATE_LIMIT_PER_SEC).toBe(50);
    expect(config.RATE_BUCKET_CAPACITY).toBe(10);
    expect(config.MAX_IN_FLIGHT).toBe(50);
    expect(config.SEND_TIMEOUT_MS).toBe(10_000);
    expect(config.RECONCILE_DELAY_MS).toBe(5_000);
    expect(config.DELIVERY_LEASE_MS).toBe(30_000);
    expect(config.TASK_LEASE_MS).toBe(30_000);
  });

  it('환경변수 문자열을 숫자로 바꾼다', () => {
    expect(
      loadConfig({ ...base, RATE_LIMIT_PER_SEC: '45' }, 'api')
        .RATE_LIMIT_PER_SEC,
    ).toBe(45);
  });

  it('형식이 틀린 값이 있으면 키와 이유를 담아 시작하지 않는다', () => {
    expect(() => loadConfig({ ...base, MAX_IN_FLIGHT: 'many' }, 'api')).toThrow(
      /MAX_IN_FLIGHT/,
    );
  });

  it('요청 한 번이 기한 안에 끝나지 않는 설정이면 시작하지 않는다', () => {
    expect(() =>
      loadConfig({ ...base, DELIVERY_LEASE_MS: '5000' }, 'worker'),
    ).toThrow(/SEND_TIMEOUT_MS < DELIVERY_LEASE_MS/);
    expect(() =>
      loadConfig({ ...base, TASK_LEASE_MS: '5000' }, 'worker'),
    ).toThrow(/USERS_TIMEOUT_MS < TASK_LEASE_MS/);
  });

  it('한 번에 꺼내는 수가 동시 발송 한도를 넘으면 시작하지 않는다', () => {
    expect(() =>
      loadConfig({ ...base, CLAIM_BATCH_MAX: '60' }, 'worker'),
    ).toThrow(/CLAIM_BATCH_MAX/);
  });

  it('프로세스 역할마다 필요한 값이 다르다', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: base.DATABASE_URL }, 'api'),
    ).toThrow(/API_KEY/);
    expect(() => loadConfig({}, 'worker')).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({}, 'migrate')).toThrow(/MIGRATION_DATABASE_URL/);
    expect(
      loadConfig({ DATABASE_URL: base.DATABASE_URL }, 'worker').API_KEY,
    ).toBeUndefined();
  });

  it('설정 외의 환경변수는 담지 않는다', () => {
    expect(loadConfig({ ...base, PATH: '/usr/bin' }, 'api')).not.toHaveProperty(
      'PATH',
    );
  });

  it('기동 로그에는 비밀값을 가린다', () => {
    const described = describeConfig(loadConfig(base, 'api'));

    expect(described.DATABASE_URL).toBe(
      'postgres://alarm_app:****@db:5432/alarm',
    );
    expect(described.API_KEY).toBe('****');
  });
});

describe('로그 마스킹 (ADR-0028)', () => {
  it('본문의 네 자리 이상 숫자를 같은 길이의 *로 바꾼다', () => {
    expect(maskDigits('인증번호 482913, 주문 12')).toBe(
      '인증번호 ******, 주문 12',
    );
  });

  it('전화번호의 가운데 자리를 가린다', () => {
    expect(maskPhone('010-1234-5678')).toBe('010-****-5678');
    expect(maskPhone('01012345678')).toBe('010-****-5678');
  });

  it('필드 이름으로 깊이 따라가며 마스킹하고 원본은 바꾸지 않는다', () => {
    const original = {
      body: '코드 9876',
      user: { phone: '010-1003-2749', name: '이유찬' },
      apiKey: 'k',
      list: [{ body: '1234' }],
    };

    expect(maskSensitive(original)).toEqual({
      body: '코드 ****',
      user: { phone: '010-****-2749', name: '이유찬' },
      apiKey: '****',
      list: [{ body: '****' }],
    });
    expect(original.body).toBe('코드 9876');
  });
});

describe('오류 로그 마스킹 (ADR-0028)', () => {
  const secretText = '인증번호 482913 입니다. 010-1234-5678';

  /** DB 드라이버처럼 실패한 행의 값을 detail에 담고, ORM처럼 바인딩 값을 message에 담은 오류. */
  function failedQueryError(): Error {
    const driverError = Object.assign(
      new Error('duplicate key value violates unique constraint'),
      { code: '23505', detail: `Failing row contains (7, ${secretText}).` },
    );

    return new Error(
      `Failed query: insert into deliveries values ($1)\nparams: ${secretText}`,
      { cause: driverError },
    );
  }

  /** 로거가 쓴 JSON 줄들을 모은다. */
  function captureLines(write: (logger: AppLogger) => void): string {
    const lines: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));

      return true;
    };
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(capture);
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(capture);

    try {
      write(new AppLogger('info', 'Test'));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    return lines.join('');
  }

  function expectMasked(output: string): void {
    expect(output).not.toContain('482913');
    expect(output).not.toContain('1234-5678');
    expect(output).toContain('******');
  }

  it('오류를 넘긴 로그는 message, stack, detail과 cause의 숫자를 가린다', () => {
    const output = captureLines((logger) =>
      logger.error('Request failed', failedQueryError()),
    );
    const line = JSON.parse(output) as {
      error: { stack: string; cause: { code: string } };
    };

    expectMasked(output);
    // 원인을 찾는 데 필요한 오류 코드와 호출 위치는 남긴다.
    expect(line.error.cause.code).toBe('23505');
    expect(line.error.stack).toMatch(/\n\s+at .+:\d+:\d+/);
  });

  it('구조화 필드 안의 오류도 가린다', () => {
    const output = captureLines((logger) =>
      logger.error('Endpoint failed', {
        url: '/metrics',
        error: failedQueryError(),
      }),
    );

    expectMasked(output);
    expect(output).toContain('23505');
  });

  it('오류를 첫 인자로 넘기거나 스택 문자열로 넘겨도 가린다', () => {
    const error = failedQueryError();
    const output = captureLines((logger) => {
      logger.error(error);
      logger.error('Failed', error.stack);
    });

    expectMasked(output);
  });
});

describe('추적 ID (ADR-0019)', () => {
  it('traceparent의 trace-id를 이어 쓴다', () => {
    expect(
      traceIdFrom('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    ).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('없거나 형식이 틀리거나 0으로만 되어 있으면 새로 만든다', () => {
    for (const header of [
      undefined,
      'garbage',
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    ]) {
      const id = traceIdFrom(header);

      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe('00000000000000000000000000000000');
    }
  });
});
