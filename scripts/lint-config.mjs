import { parser } from 'typescript-eslint';

const SOURCE_FILES = ['**/*.{js,mjs,cjs,ts,tsx}'];
const TYPESCRIPT_FILES = ['**/*.{ts,tsx}'];

const CORRECTNESS_RULES = {
  'no-cond-assign': ['error', 'except-parens'],
  'no-debugger': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unsafe-finally': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

export const LINT_CONFIG = [
  {
    ignores: [
      '**/node_modules/**',
      '**/.venv/**',
      '**/dist/**',
      '**/dist-web/**',
      '**/build/**',
      '**/.output/**',
      '**/.wxt/**',
      '**/reports/**',
      '**/*.d.{ts,mts,cts}',
      '**/*.timestamp-*.mjs',
      'packages/llm/scripts/.opencode-home/**',
      'packages/shared/src/generated/**',
      'packages/desktop/native/bin/**',
      'packages/desktop/release/**',
      'packages/comfyui/ComfyUI/**',
    ],
  },
  {
    files: SOURCE_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: CORRECTNESS_RULES,
  },
  {
    files: TYPESCRIPT_FILES,
    languageOptions: {
      parser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
  },
];
