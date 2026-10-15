/**
 * 목록 커서는 내부 형식을 감춘 불투명 값이다 (ADR-0024).
 * 마지막으로 본 항목의 위치를 base64url JSON으로 담는다.
 */
export function encodeCursor(position: string | number): string {
  return Buffer.from(JSON.stringify({ p: position })).toString('base64url');
}

/** 형식이 틀리면 undefined를 돌려준다. 호출하는 쪽이 400으로 응답한다. */
export function decodeCursor(cursor: string): string | number | undefined {
  try {
    // JSON이 null이면 .p에서 예외가 나고 아래 catch가 undefined로 돌려준다.
    const { p } = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      p?: unknown;
    };

    return typeof p === 'string' || typeof p === 'number' ? p : undefined;
  } catch {
    return undefined;
  }
}
