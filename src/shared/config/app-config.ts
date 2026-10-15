import { plainToInstance, Type } from 'class-transformer';
import { maskUrlCredentials } from '../logging/masking';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export type ProcessRole = 'api' | 'worker' | 'migrate';

/**
 * 모든 설정은 환경변수로 받고 기동 시 검증한다 (ADR-0030).
 * 기본값은 지금까지의 결정값이며, 근거 ADR을 필드마다 적는다.
 */
export class AppConfig {
  // DB (ADR-0025)
  @IsOptional() @IsString() DATABASE_URL?: string = undefined;
  @IsOptional() @IsString() MIGRATION_DATABASE_URL?: string = undefined;

  // 외부 발송 API (ADR-0002, 0006)
  @IsUrl({ require_tld: false }) EXTERNAL_API_BASE_URL = 'http://mock:4000';
  @Type(() => Number) @IsInt() @Min(100) SEND_TIMEOUT_MS = 10_000;
  @Type(() => Number) @IsInt() @Min(100) LOOKUP_TIMEOUT_MS = 10_000;
  @Type(() => Number) @IsInt() @Min(100) USERS_TIMEOUT_MS = 10_000;
  @Type(() => Number) @IsInt() @Min(0) RECONCILE_DELAY_MS = 5_000;
  @Type(() => Number) @IsInt() @Min(1_000) RECONCILE_CLAIM_LEASE_MS = 30_000;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000) USERS_PAGE_SIZE = 1000;

  // 처리량 (ADR-0009, 0013)
  @Type(() => Number) @IsNumber() @Min(0.1) RATE_LIMIT_PER_SEC = 50;
  @Type(() => Number) @IsInt() @Min(1) RATE_BUCKET_CAPACITY = 10;
  @Type(() => Number) @IsInt() @Min(1) CLAIM_BATCH_MAX = 10;
  @Type(() => Number) @IsInt() @Min(1) MAX_IN_FLIGHT = 50;

  // 재시도 (ADR-0014)
  @Type(() => Number) @IsInt() @Min(1) RETRY_BASE_MS = 1_000;
  @Type(() => Number) @IsInt() @Min(1) RETRY_MAX_MS = 60_000;
  @Type(() => Number) @IsInt() @Min(1) RETRY_MAX_ATTEMPTS = 8;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) RETRY_JITTER_RATIO = 0.2;

  // 서킷 브레이커 (ADR-0014)
  @Type(() => Number) @IsInt() @Min(1) BREAKER_WINDOW = 20;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) BREAKER_FAILURE_RATIO = 0.5;
  @Type(() => Number) @IsInt() @Min(1) BREAKER_PAUSE_MIN_MS = 5_000;
  @Type(() => Number) @IsInt() @Min(1) BREAKER_PAUSE_MAX_MS = 60_000;
  @Type(() => Number) @IsInt() @Min(0) BREAKER_STREAK_WINDOW_MS = 60_000;

  // 워커 생존 (ADR-0004, 0011, 0026)
  @Type(() => Number) @IsInt() @Min(10) HEARTBEAT_INTERVAL_MS = 2_000;
  @Type(() => Number) @IsInt() @Min(10) SEND_GUARD_MS = 5_000;
  @Type(() => Number) @IsInt() @Min(10) INVALIDATE_AFTER_MS = 15_000;
  @Type(() => Number) @IsInt() @Min(10) IDLE_POLL_MS = 500;
  @Type(() => Number) @IsInt() @Min(10) LIVENESS_STALL_MS = 30_000;
  @Type(() => Number) @IsInt() @Min(0) SHUTDOWN_GRACE_MS = 20_000;

  // 운영 (ADR-0026, 0028, 0033)
  @Type(() => Number) @IsInt() @Min(0) PORT = 3000;
  @Type(() => Number) @IsInt() @Min(0) MANAGEMENT_PORT = 9100;
  @IsIn(['info', 'debug']) LOG_LEVEL: 'info' | 'debug' = 'info';
  @IsOptional() @IsString() API_KEY?: string = undefined;

  // api의 DB 대기 한도. 요청마다 반드시 응답하기 위해서다 (ADR-0039).
  @Type(() => Number) @IsInt() @Min(100) DB_ACQUIRE_TIMEOUT_MS = 5_000;
  @Type(() => Number) @IsInt() @Min(100) DB_QUERY_TIMEOUT_MS = 30_000;
}

/** 값 하나가 아니라 값 사이의 관계가 깨지면 안전성이 무너지는 항목들 (ADR-0030). */
function relationErrors(config: AppConfig, role: ProcessRole): string[] {
  const errors: string[] = [];
  // 무효로 선언되기 전에 워커가 먼저 스스로 멈춰야 한다 (ADR-0004).
  const isLivenessOrdered =
    config.HEARTBEAT_INTERVAL_MS < config.SEND_GUARD_MS &&
    config.SEND_GUARD_MS < config.INVALIDATE_AFTER_MS;
  if (!isLivenessOrdered) {
    errors.push(
      'HEARTBEAT_INTERVAL_MS < SEND_GUARD_MS < INVALIDATE_AFTER_MS is required (ADR-0004)',
    );
  }

  const isBatchWithinInFlight = config.CLAIM_BATCH_MAX <= config.MAX_IN_FLIGHT;
  if (!isBatchWithinInFlight) {
    errors.push('CLAIM_BATCH_MAX <= MAX_IN_FLIGHT is required (ADR-0013)');
  }

  const isRetryRangeValid = config.RETRY_BASE_MS <= config.RETRY_MAX_MS;
  if (!isRetryRangeValid) {
    errors.push('RETRY_BASE_MS <= RETRY_MAX_MS is required (ADR-0014)');
  }

  const isBreakerRangeValid =
    config.BREAKER_PAUSE_MIN_MS <= config.BREAKER_PAUSE_MAX_MS;
  if (!isBreakerRangeValid) {
    errors.push(
      'BREAKER_PAUSE_MIN_MS <= BREAKER_PAUSE_MAX_MS is required (ADR-0014)',
    );
  }

  const isMigration = role === 'migrate';
  const isApi = role === 'api';
  const isAppDatabaseMissing = !isMigration && !config.DATABASE_URL;
  if (isAppDatabaseMissing) errors.push('DATABASE_URL is required');
  const isMigrationDatabaseMissing =
    isMigration && !config.MIGRATION_DATABASE_URL;
  if (isMigrationDatabaseMissing) {
    errors.push('MIGRATION_DATABASE_URL is required');
  }

  const isApiKeyMissing = isApi && !config.API_KEY;
  if (isApiKeyMissing) errors.push('API_KEY is required (ADR-0033)');

  return errors;
}

/** 틀린 값이 하나라도 있으면 어떤 키가 왜 틀렸는지 모아 예외를 던진다. 기동은 여기서 멈춘다. */
export function loadConfig(
  env: Record<string, string | undefined>,
  role: ProcessRole,
): AppConfig {
  const known = new Set(Object.keys(new AppConfig()));
  const defined = Object.fromEntries(
    // 빈 문자열은 값이 없는 것으로 본다.
    Object.entries(env).filter(([k, v]) => known.has(k) && v),
  );
  // 기본값은 필드 초기값이 맡고, 숫자 변환은 @Type이 맡는다.
  const config = plainToInstance(AppConfig, defined);
  const fieldErrors = validateSync(config).flatMap((e) =>
    Object.values(e.constraints ?? {}).map((msg) => `${e.property}: ${msg}`),
  );
  const errors = [...fieldErrors, ...relationErrors(config, role)];
  const isInvalid = errors.length > 0;
  if (isInvalid) {
    throw new Error(
      `Invalid configuration, not starting:\n - ${errors.join('\n - ')}`,
    );
  }

  return config;
}

/** 기동 로그에 남길 때 비밀값을 가린다 (ADR-0028, 0030). */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  const maskUrl = (url?: string) => url && maskUrlCredentials(url);

  return {
    ...config,
    DATABASE_URL: maskUrl(config.DATABASE_URL),
    MIGRATION_DATABASE_URL: maskUrl(config.MIGRATION_DATABASE_URL),
    API_KEY: config.API_KEY ? '****' : undefined,
  };
}
