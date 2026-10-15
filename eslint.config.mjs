// 린트 규칙 (ADR-0037). 모양은 Prettier가, 문장 사이 빈 줄과 코드 품질은 ESLint가 맡는다.
import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'drizzle/', 'reports/', 'coverage/', 'stryker-tmp/', '**/*.js', '**/*.mjs'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    // 테스트는 형식이 정해지지 않은 응답 JSON을 다루므로 any를 허용한다.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      // 여러 줄로 감싸진 if 본문에는 중괄호를 둔다. 한 줄짜리 가드는 그대로 둔다.
      curly: ['error', 'multi-line'],
      // 문장 사이는 빈 줄로 나누는 것을 기본으로 하되, 붙어 있는 편이 자연스러운 곳은 붙인다.
      // 여러 규칙이 같은 쌍에 맞으면 뒤의 것이 이긴다.
      '@stylistic/padding-line-between-statements': [
        'error',
        // return과 블록(if·for·try 등) 앞뒤는 나눈다.
        { blankLine: 'always', prev: '*', next: ['return', 'block-like'] },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        // 선언이 끝나면 나눈다. 이어진 선언끼리는 붙여도 된다.
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        // 조건을 담은 is 변수와 그 조건을 쓰는 if는 붙인다 (CLAUDE.md).
        { blankLine: 'any', prev: ['const', 'let'], next: 'if' },
        // 이어지는 case 라벨 사이는 띄우지 않는다. 띄우면 빈 case가 아래로 흘러가는 것처럼 보인다.
        { blankLine: 'never', prev: 'case', next: 'case' },
      ],
    },
  },
);
