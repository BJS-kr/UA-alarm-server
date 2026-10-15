/**
 * 단위 테스트만 도는 설정. 변이 테스팅(Stryker)이 쓴다 (ADR-0034 2층).
 * 변이 하나마다 테스트를 다시 돌리므로 DB가 필요한 통합 테스트는 넣지 않는다.
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  setupFiles: ['reflect-metadata'],
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
};
