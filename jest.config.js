/** @type {import('jest').Config} */
const transform = { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] };

module.exports = {
  // 통합 테스트는 실제 시간으로 장애 상황을 재현하므로 넉넉히 준다. 프로젝트별 설정으로는 적용되지 않는다.
  testTimeout: 60000,
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform,
      setupFiles: ['reflect-metadata'],
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform,
      setupFiles: ['reflect-metadata'],
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
    },
  ],
};
