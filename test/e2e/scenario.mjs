// 끝단 시나리오 (ADR-0035). compose 네트워크 안에서 실행한다: scripts/e2e.sh 참고.
//   node test/e2e/scenario.mjs start          대량·긴급 알림을 만들고 발송을 시작한다. 알림 ID 두 개를 출력한다.
//   node test/e2e/scenario.mjs verify <ids>   끝날 때까지 기다린 뒤 외부 기록과 메트릭으로 검증한다.
import { resolve4 } from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE_URL ?? 'http://api:3000';
const KEY = process.env.API_KEY ?? 'dev-api-key';
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
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
  const bulk = await call('POST', '/v1/alarms', { type: 'BULK', title: 'E2E 대량', body: 'E2E 대량 알림 본문' });
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

async function metricSum(hosts, name) {
  let total = 0;
  for (const host of hosts) {
    try {
      const text = await (await fetch(`http://${host}:9100/metrics`, { signal: AbortSignal.timeout(3000) })).text();
      for (const line of text.split('\n')) if (line.startsWith(name)) total += Number(line.split(' ').pop());
    } catch {
      // 죽은 워커의 메트릭은 남지 않는다.
    }
  }
  return total;
}

async function verify(ids) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const alarms = await Promise.all(ids.map((id) => call('GET', `/v1/alarms/${id}`)));
    if (alarms.every((a) => ['COMPLETED', 'CANCELED'].includes(a.status))) break;
    if (Date.now() > deadline) throw new Error(`끝나지 않았다: ${alarms.map((a) => `${a.id}=${a.status}`).join(', ')}`);
    await sleep(2000);
  }
  // 외부 기록 대조는 verify.mjs가 한다.
  execFileSync(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url)), ...ids], { stdio: 'inherit' });

  const workers = await resolve4('worker').catch(() => []);
  const pauses = await metricSum(workers, 'alarm_rate_limit_pauses_total');
  const duplicates = await metricSum(workers, 'alarm_duplicates_detected_total');
  const takeovers = await metricSum(workers, 'alarm_takeovers_total');
  console.log(JSON.stringify({ liveWorkers: workers.length, rateLimitPauses: pauses, duplicatesDetected: duplicates, takeovers }));
  // 429가 "지속적으로" 나면 안 된다. 워커가 죽고 넘겨받는 동안의 몇 번은 허용한다.
  if (pauses > 5 || duplicates > 0) {
    console.log('E2E 실패: 429가 지속됐거나 중복이 탐지됐다');
    process.exit(1);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'start') await start();
else if (command === 'verify') await verify(args);
else {
  console.error('사용법: scenario.mjs start | verify <alarmId>...');
  process.exit(2);
}
