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

  // 접속 주소의 비밀번호는 필드 이름과 관계없이 가린다.
  return maskUrlCredentials(value);
}

/**
 * 우리가 쓰지 않은 글(오류 메시지, 라이브러리 로그)은 어디에 무엇이 들었는지 모른다.
 * 그래서 필드 이름과 관계없이 네 자리 이상 숫자와 접속 주소의 비밀번호를 가린다.
 */
export function maskFreeText(text: string): string {
  return maskUrlCredentials(maskDigits(text));
}

/** 호출 위치 줄(`    at ...`)은 그대로 둔다. 줄 번호까지 가리면 오류가 난 곳을 찾을 수 없다. */
export function maskStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => (/^\s+at /.test(line) ? line : maskFreeText(line)))
    .join('\n');
}

/** 오류의 종류만 나타내고 내용은 담지 않는 필드. 가리면 원인을 찾을 수 없다(예: Postgres 코드 23505). */
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
 * 오류를 글을 가린 일반 객체로 바꾼다 (ADR-0028). 모양은 NestJS 기본 직렬화와 같다:
 * name, message, stack, 원시값 필드, 그리고 cause와 errors(AggregateError)를 따라 내려간다.
 * DB 드라이버와 ORM은 실패한 문장의 값(본문, 수신자)을 message나 detail에 담으므로 필드 이름이 아니라 내용으로 가린다.
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
