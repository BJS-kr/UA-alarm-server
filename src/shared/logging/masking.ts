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
  return phone.replace(/^(\d{2,3})-?(\d{3,4})-?(\d{4})$/, (_m, a: string, b: string, c: string) => `${a}-${'*'.repeat(b.length)}-${c}`);
}

/** 접속 주소의 비밀번호를 가린다. postgres://user:pw@host → postgres://user:****@host */
export function maskUrlCredentials(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:****@');
}

const SECRET_KEYS = new Set(['password', 'apikey', 'api_key', 'authorization', 'secret', 'token']);
const BODY_KEYS = new Set(['body']);
const PHONE_KEYS = new Set(['phone']);

function maskValue(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (typeof value !== 'string') return value;
  if (SECRET_KEYS.has(k)) return '****';
  if (BODY_KEYS.has(k)) return maskDigits(value);
  if (PHONE_KEYS.has(k)) return maskPhone(value);
  // 접속 주소의 비밀번호는 필드 이름과 관계없이 가린다.
  return maskUrlCredentials(value);
}

/**
 * 객체를 깊게 따라가며 규칙에 맞는 필드만 바꾼 사본을 돌려준다. 원본은 바꾸지 않는다.
 * 깊이 제한은 순환 참조로 끝없이 내려가는 것을 막는다.
 */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return value;
  if (Array.isArray(value)) return value.map((item) => maskSensitive(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = typeof inner === 'object' ? maskSensitive(inner, depth + 1) : maskValue(key, inner);
  }
  return out;
}
