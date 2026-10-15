/**
 * 목록 커서는 내부 형식을 감춘 불투명 값이다 (ADR-0024).
 * 마지막으로 본 항목의 위치를 base64url JSON으로 담는다.
 */
export function encodeCursor(position: string | number): string {
  return Buffer.from(JSON.stringify({ p: position }), 'utf8').toString('base64url');
}

/** 형식이 틀리면 undefined를 돌려준다. 호출하는 쪽이 400으로 응답한다. */
export function decodeCursor(cursor: string): string | number | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && 'p' in parsed) {
      const p = (parsed as { p: unknown }).p;
      if (typeof p === 'string' || typeof p === 'number') return p;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
