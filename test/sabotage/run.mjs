// 고의 결함을 하나씩 적용해 지정한 테스트가 실제로 실패하는지 확인한다 (ADR-0034 3층).
// 사용법: node test/sabotage/run.mjs [S01 S02 ...]
// 결함마다 원본을 되돌린다. 하나라도 검출되지 않으면 종료 코드 1.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SABOTAGES } from './sabotages.mjs';

const jestBin = path.join('node_modules', 'jest', 'bin', 'jest.js');
const tscBin = path.join('node_modules', 'typescript', 'bin', 'tsc');
// 컴파일된 워커를 자식 프로세스로 띄우는 테스트는 dist를 다시 빌드해야 결함이 반영된다.
const build = () => spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], { encoding: 'utf8' });
const only = new Set(process.argv.slice(2));
const selected = SABOTAGES.filter((s) => only.size === 0 || only.has(s.id));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const results = [];
for (const sabotage of selected) {
  const original = readFileSync(sabotage.file, 'utf8');
  const occurrences = original.split(sabotage.find).length - 1;
  if (occurrences !== 1) {
    results.push({ ...sabotage, verdict: `적용 불가: 원본에 ${occurrences}번 나온다` });
    continue;
  }
  writeFileSync(sabotage.file, original.replace(sabotage.find, sabotage.replace));
  try {
    if (sabotage.build && build().status !== 0) throw new Error('빌드 실패: 결함이 dist에 반영되지 않았다');
    const run = spawnSync(
      process.execPath,
      // 결함 때문에 열린 핸들이 남아도 끝나도록 --forceExit, 그래도 멈추면 시간 초과로 끊는다.
      ['--experimental-vm-modules', jestBin, '--ci', '--forceExit', sabotage.test, '-t', escape(sabotage.name), '--testTimeout', '30000'],
      { encoding: 'utf8', env: process.env, timeout: 180_000 },
    );
    const output = `${run.stdout}${run.stderr}`;
    const ran = /Tests:.*\d+ (passed|failed)/.test(output) && !/Tests:.*0 total/.test(output);
    const failed = run.status !== 0 && /Tests:.*\d+ failed/.test(output);
    const verdict = run.error ? `실행 오류: ${run.error.message}` : !ran ? '테스트가 실행되지 않음' : failed ? '검출' : '놓침';
    results.push({ ...sabotage, verdict });
  } catch (error) {
    results.push({ ...sabotage, verdict: error.message });
  } finally {
    writeFileSync(sabotage.file, original);
    if (sabotage.build) build();
  }
  const last = results[results.length - 1];
  console.log(`${last.id} [ADR-${last.adr}] ${last.what} → ${last.verdict}`);
}

const missed = results.filter((r) => r.verdict !== '검출');
console.log(`\n${results.length - missed.length}/${results.length} 검출`);
process.exit(missed.length === 0 ? 0 : 1);
