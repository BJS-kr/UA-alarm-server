/**
 * 변이 테스팅 (ADR-0034 2층). 대상은 IO가 없는 TS 순수 로직이다.
 * SQL과 동시성은 TS 변이 도구가 의미 있는 결함을 만들지 못하므로 test/sabotage의 고의 결함 목록이 맡는다.
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'jest',
  jest: { projectType: 'custom', configFile: 'jest.unit.config.js' },
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  coverageAnalysis: 'perTest',
  mutate: [
    'src/shared/domain/**/*.ts',
    'src/shared/logging/masking.ts',
    'src/shared/config/app-config.ts',
    'src/shared/external/external-api.client.ts',
    'src/api/http/trace.middleware.ts',
    'src/api/http/http-semantics.middleware.ts',
  ],
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  // 남은 생존 변이는 결과가 같은 변이(동등 변이)로 판정했다(docs/testing.md). 점수가 떨어지면 실패한다.
  thresholds: { high: 95, low: 90, break: 90 },
  tempDirName: 'stryker-tmp',
  cleanTempDir: 'always',
};
