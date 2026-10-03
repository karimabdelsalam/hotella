// ESLint 10 flat config — Hotella.
// Layer rules (ADR-0001): contracts → zod only; platform → never domain; domain → other domains only via /public.
// Code rules (CLAUDE.md): no console, no process.env outside platform-config/platform-secrets, ESM-ready source.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const PROCESS_ENV_MESSAGE =
  'Read configuration through @hotella/platform-config (and secrets through @hotella/platform-secrets); never process.env directly (CLAUDE.md rule 13).';

const esmReadyRules = {
  'no-restricted-globals': [
    'error',
    {
      name: '__dirname',
      message: 'ESM-ready source: use import.meta.url helpers from platform packages (ADR-0016).',
    },
    {
      name: '__filename',
      message: 'ESM-ready source: use import.meta.url helpers from platform packages (ADR-0016).',
    },
    { name: 'require', message: 'ESM-ready source: use import (ADR-0016).' },
  ],
  'no-console': ['error'],
  'no-restricted-properties': [
    'error',
    { object: 'process', property: 'env', message: PROCESS_ENV_MESSAGE },
  ],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/explicit-module-boundary-types': 'off',
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.name='require']",
      message: 'ESM-ready source: use import (ADR-0016).',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'docs/**',
      'tooling/lint-fixtures/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Source and tests: type-aware so consistent-type-imports understands NestJS constructor injection
  // (emitDecoratorMetadata). Each folder has a tsconfig the project service can discover.
  {
    files: [
      'apps/**/src/**/*.ts',
      'apps/**/test/**/*.ts',
      'packages/**/src/**/*.ts',
      'tooling/lint-fixtures/**/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
      },
    },
    rules: esmReadyRules,
  },
  // Config files are linted without type information.
  {
    files: ['**/vitest.config.mts'],
    languageOptions: { globals: { ...globals.node }, parserOptions: { projectService: false } },
  },
  // Tooling, config files and scripts are plain Node programs: console and env are fine there.
  {
    files: [
      'tooling/**/*.mjs',
      'scripts/**/*.{mjs,js}',
      '*.mjs',
      '*.cjs',
      '**/vitest.config.mts',
      '**/*.config.{mjs,cjs,mts}',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Only the config and secrets packages may touch process.env.
  {
    files: ['packages/platform/config/**/*.ts', 'packages/platform/secrets/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  // Entry points (main.ts) may log fatal boot errors before the logger exists.
  {
    files: ['apps/*/src/main.ts'],
    rules: { 'no-console': ['error', { allow: ['error'] }] },
  },
  // LAYER: contracts import only zod and other contracts.
  {
    files: ['packages/contracts/**/*.ts', 'tooling/lint-fixtures/packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hotella/domain-*', '@hotella/platform-*', '@nestjs/*'],
              message:
                'contracts/* may import only zod and other @hotella/contracts-* packages (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
  // LAYER: platform never imports domain.
  {
    files: ['packages/platform/**/*.ts', 'tooling/lint-fixtures/packages/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hotella/domain-*'],
              message: 'platform/* must not depend on domain packages (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
  // LAYER: a domain reaches another domain only through its /public entry point.
  {
    files: ['packages/domain/**/*.ts', 'tooling/lint-fixtures/packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hotella/domain-*', '!@hotella/domain-*/public'],
              message:
                'Import another bounded context only via "@hotella/domain-<ctx>/public" (ADR-0001, CLAUDE.md).',
            },
            {
              group: ['@hotella/domain-*/src/*', '@hotella/domain-*/dist/*'],
              message: 'Deep imports into another bounded context are forbidden (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
  // Apps compose modules but still never deep-import a domain's internals.
  {
    files: ['apps/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@hotella/domain-*/src/*',
                '@hotella/domain-*/dist/*',
                '@hotella/platform-*/src/*',
              ],
              message: 'Deep imports are forbidden; use the package entry points (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
);
