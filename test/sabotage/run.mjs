// 고의 결함을 하나씩 적용해 지정한 테스트가 실제로 실패하는지 확인한다 (ADR-0034 3층).
// 사용법: node test/sabotage/run.mjs [S01 S02 ...]
// 결함마다 원본을 되돌린다. 하나라도 검출되지 않으면 종료 코드 1.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { SABOTAGES } from './sabotages.mjs';

const jestBin = path.join('node_modules', 'jest', 'bin', 'jest.js');
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
    const run = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', jestBin, '--ci', sabotage.test, '-t', escape(sabotage.name), '--testTimeout', '30000'],
      { encoding: 'utf8', env: process.env },
    );
    const output = `${run.stdout}${run.stderr}`;
    const ran = /Tests:.*\d+ (passed|failed)/.test(output) && !/Tests:.*0 total/.test(output);
    const failed = run.status !== 0 && /Tests:.*\d+ failed/.test(output);
    results.push({ ...sabotage, verdict: !ran ? '테스트가 실행되지 않음' : failed ? '검출' : '놓침' });
  } finally {
    writeFileSync(sabotage.file, original);
  }
  const last = results[results.length - 1];
  console.log(`${last.id} [ADR-${last.adr}] ${last.what} → ${last.verdict}`);
}

const missed = results.filter((r) => r.verdict !== '검출');
console.log(`\n${results.length - missed.length}/${results.length} 검출`);
process.exit(missed.length === 0 ? 0 : 1);
