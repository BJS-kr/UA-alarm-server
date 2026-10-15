/** @type {import('jest').Config} */
const transform = { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] };

module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform,
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform,
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      // 각 테스트 파일이 자기 DB를 만들어 쓰므로 파일 간 병렬 실행은 허용하되 시간은 넉넉히 준다.
      testTimeout: 60000,
    },
  ],
};
