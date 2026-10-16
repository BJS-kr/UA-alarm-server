/**
 * 비밀정보는 빼지 않고 마스킹한다 (ADR-0028).
 * 필드 이름으로 규칙을 정하므로 로그를 찍는 쪽에서 빠뜨릴 수 없다.
 */

/** 네 자리 이상 이어진 숫자(인증번호, 카드번호 등)를 같은 길이의 *로 바꾼다. */
export function maskDigits(text: string): string {
  return text.replace(/\d{4,}/g, (digits) => '*'.repeat(digits.length));
}

/** 전화번호의 가운데 자리를 가린다. 010-1234-5678 → 010-****-5678 */
export function maskPhone(phone: string): string {
  return phone.replace(
    /^(\d{2,3})-?(\d{3,4})-?(\d{4})$/,
    (_m, a: string, b: string, c: string) =>
      `${a}-${'*'.repeat(b.length)}-${c}`,
  );
}

/** 접속 주소의 비밀번호를 가린다. postgres://user:pw@host → postgres://user:****@host */
export function maskUrlCredentials(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:****@');
}

const SECRET_KEYS = new Set([
  'password',
  'apikey',
  'api_key',
  'authorization',
  'secret',
  'token',
]);
const BODY_KEYS = new Set(['body']);
const PHONE_KEYS = new Set(['phone']);

function maskValue(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  const isText = typeof value === 'string';
  if (!isText) return value;
  const isSecret = SECRET_KEYS.has(k);
  if (isSecret) return '****';
  const isBody = BODY_KEYS.has(k);
  if (isBody) return maskDigits(value);
  const isPhone = PHONE_KEYS.has(k);
  if (isPhone) return maskPhone(value);

  // URL 내 자격 증명은 필드명과 무관하게 마스킹한다.
  return maskUrlCredentials(value);
}

/**
 * 자유 형식 문자열(외부 오류 메시지, 라이브러리 로그 등)에서 4자리 이상 연속 숫자와 URL 자격 증명을 마스킹한다.
 */
export function maskFreeText(text: string): string {
  return maskUrlCredentials(maskDigits(text));
}

/** 스택 프레임 줄(`    at ...`)은 라인 번호 보존을 위해 마스킹에서 제외한다. */
export function maskStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => (/^\s+at /.test(line) ? line : maskFreeText(line)))
    .join('\n');
}

/** 오류 식별용 메타데이터 필드(예: PostgreSQL 오류 코드 23505)는 마스킹에서 제외한다. */
const ERROR_ID_KEYS = new Set(['name', 'code', 'errno', 'syscall', 'severity']);
const MAX_ERROR_DEPTH = 5;

function maskErrorField(key: string, value: unknown): unknown {
  const isText = typeof value === 'string';
  if (!isText) return value;
  const isId = ERROR_ID_KEYS.has(key);
  if (isId) return value;
  const isSecret = SECRET_KEYS.has(key.toLowerCase());
  if (isSecret) return '****';
  const isStack = key === 'stack';
  if (isStack) return maskStack(value);

  return maskFreeText(value);
}

/**
 * Error 객체를 마스킹된 일반 객체로 직렬화한다 (ADR-0028).
 * name, message, stack, 원시 프로퍼티 및 중첩된 cause, errors(AggregateError)를 재귀적으로 마스킹한다.
 */
export function maskError(
  error: Error,
  depth = 0,
  ancestors = new Set<Error>(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields: Array<[string, unknown]> = [
    ['name', error.name],
    ['message', error.message],
    ['stack', error.stack],
    ...Object.entries(error),
  ];

  for (const [key, value] of fields) {
    const isPrimitive =
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function');
    // cause와 errors(배열)는 아래에서 따로 따라간다. 원시값 cause는 아래에서 같은 값으로 덮인다.
    const isCopied = isPrimitive && !(key in out);
    if (isCopied) out[key] = maskErrorField(key, value);
  }

  const nested = (inner: unknown): unknown => {
    const isInnerError = inner instanceof Error;
    if (!isInnerError) {
      return typeof inner === 'string'
        ? maskFreeText(inner)
        : maskSensitive(inner);
    }

    const isCircular = ancestors.has(inner);
    if (isCircular) return '[Circular]';
    const isTooDeep = depth + 1 > MAX_ERROR_DEPTH;
    if (isTooDeep) return '[Truncated]';

    return maskError(inner, depth + 1, ancestors);
  };

  ancestors.add(error);
  const hasCause = error.cause !== undefined;
  if (hasCause) out.cause = nested(error.cause);
  const errors = (error as { errors?: unknown }).errors;
  const isAggregate = Array.isArray(errors);
  if (isAggregate) out.errors = errors.map(nested);
  ancestors.delete(error);

  return out;
}

/**
 * 객체를 깊게 따라가며 규칙에 맞는 필드만 바꾼 사본을 돌려준다. 원본은 바꾸지 않는다.
 * 깊이 제한은 순환 참조로 끝없이 내려가는 것을 막는다.
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  const isLeaf = depth > 6 || value === null || typeof value !== 'object';
  if (isLeaf) return value;
  const isError = value instanceof Error;
  if (isError) return maskError(value);
  const isList = Array.isArray(value);
  if (isList) {
    return (value as unknown[]).map((item) => maskSensitive(item, depth + 1));
  }

  const out: Record<string, unknown> = {};

  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      typeof inner === 'object'
        ? maskSensitive(inner, depth + 1)
        : maskValue(key, inner);
  }

  return out;
}
