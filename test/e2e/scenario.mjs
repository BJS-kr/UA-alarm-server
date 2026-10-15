// 끝단 시나리오 (ADR-0035). compose 네트워크 안에서 실행한다: scripts/e2e.sh 참고.
//   node test/e2e/scenario.mjs start          대량·긴급 알림을 만들고 발송을 시작한다. 알림 ID 두 개를 출력한다.
//   node test/e2e/scenario.mjs verify <ids>   끝날 때까지 기다린 뒤 외부 기록과 메트릭으로 검증한다. 긴급이 먼저 나갔는지도 본다.
//   node test/e2e/scenario.mjs cancel         대량 알림을 발송 도중 취소하고, 취소 뒤 외부 기록이 늘지 않는지 본다.
import { resolve4 } from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE_URL ?? 'http://api:3000';
const KEY = process.env.API_KEY ?? 'dev-api-key';
const MOCK = process.env.MOCK_BASE_URL ?? 'http://mock:4000';
const H = {
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (res.status >= 400)
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json)}`,
    );
  return json;
}

async function waitForApi() {
  for (let i = 0; i < 120; i++) {
    try {
      await call('GET', '/v1/alarms?limit=1');
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error('API가 준비되지 않았다');
}

async function start() {
  await waitForApi();
  const bulk = await call('POST', '/v1/alarms', {
    type: 'BULK',
    title: 'E2E 대량',
    body: 'E2E 대량 알림 본문',
  });
  await call('POST', `/v1/alarms/${bulk.id}/send`);
  await sleep(3000);
  const urgent = await call('POST', '/v1/alarms', {
    type: 'URGENT',
    title: 'E2E 긴급',
    body: '인증번호 482913',
    recipientIds: ['u_000001', 'u_000002', 'u_000089', 'u_001999'],
  });
  await call('POST', `/v1/alarms/${urgent.id}/send`);
  console.log(`${bulk.id} ${urgent.id}`);
}

/** 대량 알림 하나만 만들고 시작한다. 장애 시나리오(scripts/e2e-faults.sh)가 쓴다. */
async function bulk() {
  await waitForApi();
  const alarm = await call('POST', '/v1/alarms', {
    type: 'BULK',
    title: 'E2E 장애 시나리오',
    body: 'E2E 대량 알림 본문',
  });
  await call('POST', `/v1/alarms/${alarm.id}/send`);
  console.log(alarm.id);
}

async function metricSum(hosts, name) {
  let total = 0;
  for (const host of hosts) {
    try {
      const text = await (
        await fetch(`http://${host}:9100/metrics`, {
          signal: AbortSignal.timeout(3000),
        })
      ).text();
      for (const line of text.split('\n'))
        if (line.startsWith(name)) total += Number(line.split(' ').pop());
    } catch {
      // 죽은 워커의 메트릭은 남지 않는다.
    }
  }
  return total;
}

async function verify(ids) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    // DB 재시작 같은 장애 중에는 API가 잠깐 503을 낸다. 끝날 때까지 기다린다.
    const alarms = await Promise.all(
      ids.map((id) => call('GET', `/v1/alarms/${id}`)),
    ).catch(() => null);
    if (
      alarms &&
      alarms.every((a) => ['COMPLETED', 'CANCELED'].includes(a.status))
    )
      break;
    if (Date.now() > deadline)
      throw new Error(
        `끝나지 않았다: ${(alarms ?? []).map((a) => `${a.id}=${a.status}`).join(', ')}`,
      );
    await sleep(2000);
  }
  // 외부 기록 대조는 verify.mjs가 한다.
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./verify.mjs', import.meta.url)), ...ids],
    { stdio: 'inherit' },
  );

  const workers = await resolve4('worker').catch(() => []);
  const pauses = await metricSum(workers, 'alarm_rate_limit_pauses_total');
  const duplicates = await metricSum(
    workers,
    'alarm_duplicates_detected_total',
  );
  const takeovers = await metricSum(workers, 'alarm_takeovers_total');
  console.log(
    JSON.stringify({
      liveWorkers: workers.length,
      rateLimitPauses: pauses,
      duplicatesDetected: duplicates,
      takeovers,
    }),
  );

  // 외부 서비스(mock) 쪽 집계로 다시 확인한다. 우리 DB만 보면 펼치기에서 빠진 사용자는 보이지 않는다.
  const problems = [];
  for (const id of ids) {
    const ours = await call('GET', `/v1/alarms/${id}`);
    const theirs = await mockStats(id);
    console.log(
      JSON.stringify({
        alarmId: id,
        type: ours.type,
        ours: ours.counts,
        mock: theirs,
      }),
    );
    if (theirs.duplicateRecipients !== 0)
      problems.push(
        `${id}: mock이 중복 수신자 ${theirs.duplicateRecipients}명을 기록했다`,
      );
    if (theirs.uniqueRecipients !== ours.counts.sent)
      problems.push(
        `${id}: mock 수신자 ${theirs.uniqueRecipients}명과 우리 SENT ${ours.counts.sent}건이 다르다`,
      );
    if (ours.type === 'BULK') {
      // 대량 알림은 전체 사용자다. 수신 거부 사용자를 뺀 모두가 받아야 한다.
      if (theirs.missingRecipients !== 0)
        problems.push(
          `${id}: mock 기준 누락 수신자 ${theirs.missingRecipients}명`,
        );
      const users = theirs.expectedRecipients + theirs.blockedRecipients;
      if (ours.counts.total !== users)
        problems.push(
          `${id}: Delivery ${ours.counts.total}건이 사용자 수 ${users}명과 다르다`,
        );
    }
  }
  problems.push(...(await urgentProblems(ids)));
  const { counters } = await mockStats();
  console.log(JSON.stringify({ mockCounters: counters }));
  // 429가 "지속적으로" 나면 안 된다. 워커가 죽고 넘겨받는 동안의 몇 번은 허용한다.
  // 외부 서비스가 멈췄다 풀리는 장애 시나리오에서는 밀린 요청이 한꺼번에 도착해 429가 잠깐 몰린다. 그때는 429를 보지 않는다.
  const isBurstAllowed = process.env.ALLOW_429_BURST === '1';
  const isRateLimitSustained = pauses > 5 || counters.rateLimited > 20;
  if (!isBurstAllowed && isRateLimitSustained)
    problems.push(
      `429가 지속됐다 (정지 ${pauses}회, mock 429 ${counters.rateLimited}건)`,
    );
  if (duplicates > 0) problems.push(`워커가 중복을 ${duplicates}건 탐지했다`);
  if (problems.length > 0) {
    console.log(`E2E 실패:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('E2E 외부 집계 확인 통과');
}

/**
 * 긴급 알림이 대량 알림 뒤에 줄 서지 않았는지 본다 (ADR-0011).
 * 긴급은 대량을 시작하고 몇 초 뒤에 시작한다. 우선순위가 없으면 긴급의 Delivery는 대량의 남은 건 뒤에 서서 대량이 끝날 무렵 나간다.
 */
async function urgentProblems(ids) {
  const alarms = await Promise.all(
    ids.map((id) => call('GET', `/v1/alarms/${id}`)),
  );
  const bulk = alarms.find((a) => a.type === 'BULK');
  const urgent = alarms.find((a) => a.type === 'URGENT');
  if (!bulk || !urgent) return [];
  const { items } = await call(
    'GET',
    `/v1/alarms/${urgent.id}/deliveries?status=SENT&limit=100`,
  );
  if (items.length === 0)
    return [`${urgent.id}: 긴급 알림이 한 건도 나가지 않았다`];
  const lastSentAt = Math.max(...items.map((d) => Date.parse(d.sentAt)));
  const urgentLatencyMs = lastSentAt - Date.parse(urgent.startedAt);
  const bulkFinishedAfterUrgentMs = Date.parse(bulk.finishedAt) - lastSentAt;
  console.log(JSON.stringify({ urgentLatencyMs, bulkFinishedAfterUrgentMs }));
  const problems = [];
  // 일시 오류로 두세 번 재시도해도(1초, 2초, 4초) 들어오는 한도다.
  if (urgentLatencyMs > 15_000)
    problems.push(
      `긴급 알림의 마지막 발송이 시작 후 ${urgentLatencyMs}ms 걸렸다`,
    );
  if (bulkFinishedAfterUrgentMs < 5_000)
    problems.push(
      `긴급 알림이 대량 알림이 끝나기 ${bulkFinishedAfterUrgentMs}ms 전에야 다 나갔다 (대량 뒤에 줄 섬)`,
    );
  return problems;
}

/**
 * 발송 중 취소 (ADR-0017). 대량 알림이 일부 나간 뒤 취소하고, CANCELED가 된 뒤에는 외부 기록이 늘지 않는지 본다.
 * 다른 알림이 끝난 뒤에 따로 실행해, 취소할 때 이 알림이 실제로 나가고 있게 한다.
 */
async function cancel() {
  await waitForApi();
  const alarm = await call('POST', '/v1/alarms', {
    type: 'BULK',
    title: 'E2E 취소',
    body: 'E2E 취소 시나리오 본문',
  });
  await call('POST', `/v1/alarms/${alarm.id}/send`);
  for (
    let i = 0;
    (await call('GET', `/v1/alarms/${alarm.id}`)).counts.sent < 100;
    i++
  ) {
    if (i > 120) throw new Error('취소할 만큼 발송이 진행되지 않았다');
    await sleep(500);
  }
  const canceling = await call('POST', `/v1/alarms/${alarm.id}/cancel`);
  let ours = canceling;
  for (let i = 0; ours.status !== 'CANCELED'; i++) {
    if (i > 120) throw new Error(`취소가 끝나지 않았다: ${ours.status}`);
    await sleep(500);
    ours = await call('GET', `/v1/alarms/${alarm.id}`);
  }
  const atCancel = await mockStats(alarm.id);
  // 이미 나간 요청의 결과까지 기다린 뒤 CANCELED가 되므로, 그 뒤에는 외부 기록이 늘면 안 된다.
  await sleep(5000);
  const later = await mockStats(alarm.id);
  console.log(
    JSON.stringify({
      alarmId: alarm.id,
      cancelResponse: canceling.status,
      ours: ours.counts,
      mockAtCancel: atCancel.uniqueRecipients,
      mockLater: later.uniqueRecipients,
    }),
  );
  const problems = [];
  if (canceling.status !== 'CANCELING')
    problems.push(
      `발송 중 취소의 응답이 CANCELING이 아니다: ${canceling.status}`,
    );
  if (later.uniqueRecipients !== atCancel.uniqueRecipients)
    problems.push(
      `CANCELED 뒤에도 외부 기록이 늘었다 (${atCancel.uniqueRecipients} → ${later.uniqueRecipients})`,
    );
  if (later.uniqueRecipients !== ours.counts.sent)
    problems.push(
      `mock 수신자 ${later.uniqueRecipients}명과 우리 SENT ${ours.counts.sent}건이 다르다`,
    );
  if (later.duplicateRecipients !== 0)
    problems.push(
      `mock이 중복 수신자 ${later.duplicateRecipients}명을 기록했다`,
    );
  if (ours.counts.canceled === 0) problems.push('취소로 보내지 않은 건이 없다');
  if (problems.length > 0) {
    console.log(`E2E 실패:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('E2E 취소 확인 통과');
}

/** mock의 평가용 집계. docker-compose.e2e.yml이 ADMIN=1로 켠다. */
async function mockStats(alarmId) {
  const query = alarmId ? `?alarmId=${alarmId}` : '';
  const res = await fetch(`${MOCK}/_admin/stats${query}`);
  if (!res.ok)
    throw new Error(
      `mock 집계를 읽지 못했다 (${res.status}). ADMIN=1인지 확인한다`,
    );
  return res.json();
}

const [command, ...args] = process.argv.slice(2);
if (command === 'start') await start();
else if (command === 'bulk') await bulk();
else if (command === 'verify') await verify(args);
else if (command === 'cancel') await cancel();
else {
  console.error(
    '사용법: scenario.mjs start | bulk | cancel | verify <alarmId>...',
  );
  process.exit(2);
}
