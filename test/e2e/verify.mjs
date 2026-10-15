// 끝단 검증 (ADR-0035): 외부 발송 내역 조회로 수신자마다 기록이 정확히 한 번인지 확인한다.
// 사용법: node test/e2e/verify.mjs <alarmId> [<alarmId> ...]
// 환경변수: API_BASE_URL, API_KEY, MOCK_BASE_URL
const API = process.env.API_BASE_URL ?? 'http://api:3000';
const MOCK = process.env.MOCK_BASE_URL ?? 'http://mock:4000';
const KEY = process.env.API_KEY ?? 'dev-api-key';
const alarmIds = process.argv.slice(2);

async function api(path) {
  const res = await fetch(API + path, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function allDeliveries(alarmId) {
  const items = [];
  let cursor = null;
  do {
    const page = await api(
      `/v1/alarms/${alarmId}/deliveries?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function lookupCount(clientRef) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(
        `${MOCK}/v1/messages?clientRef=${encodeURIComponent(clientRef)}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (res.ok) return (await res.json()).messages.length;
    } catch {
      // 느린 응답과 일시 오류는 다시 조회한다.
    }
  }
  throw new Error(`조회 실패: ${clientRef}`);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

let ok = true;
for (const alarmId of alarmIds) {
  const alarm = await api(`/v1/alarms/${alarmId}`);
  const deliveries = await allDeliveries(alarmId);
  const counts = await mapLimit(deliveries, 20, (d) =>
    lookupCount(`${alarmId}:${d.recipientId}`),
  );
  const problems = [];
  deliveries.forEach((d, i) => {
    const n = counts[i];
    if (d.status === 'SENT' && n !== 1)
      problems.push(`${d.recipientId}: SENT인데 외부 기록 ${n}건`);
    if (d.status !== 'SENT' && n !== 0)
      problems.push(`${d.recipientId}: ${d.status}인데 외부 기록 ${n}건`);
  });
  const summary = {
    alarmId,
    type: alarm.type,
    status: alarm.status,
    counts: alarm.counts,
    externalRecords: counts.reduce((a, b) => a + b, 0),
    duplicates: counts.filter((n) => n > 1).length,
    problems: problems.length,
  };
  console.log(JSON.stringify(summary));
  for (const p of problems.slice(0, 20)) console.log('  ', p);
  if (problems.length > 0 || !['COMPLETED', 'CANCELED'].includes(alarm.status))
    ok = false;
}
console.log(ok ? 'E2E 검증 통과' : 'E2E 검증 실패');
process.exit(ok ? 0 : 1);
