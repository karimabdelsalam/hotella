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
      '**/.next/**',
      '**/test-results/**',
      '**/playwright-report/**',
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
      '**/bin/*.mjs',
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
              // A regex, not a glob: gitignore-style negation cannot re-include `/public` under an excluded package.
              regex: '^@hotella/domain-[a-z0-9-]+(?:/(?!public$).*)?$',
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
  // Integration specs (and their shared test harness, never built into dist) compose other contexts' Nest modules the
  // way an app does (main entry only, never internals).
  {
    files: ['packages/domain/**/*.integration.spec.ts', 'packages/domain/*/src/testing/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@hotella/domain-*/src/*', '@hotella/domain-*/dist/*'],
              message: 'Deep imports into another bounded context are forbidden (ADR-0001).',
            },
          ],
        },
      ],
    },
  },
  // SCHEMA: ids are application-generated UUIDv7 (ADR-0003); no DB-side random uuid defaults.
  {
    files: [
      '**/infrastructure/schema.ts',
      '**/infrastructure/schema/**/*.ts',
      'packages/platform/database/src/schema/**/*.ts',
      'tooling/lint-fixtures/**/schema.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require']",
          message: 'ESM-ready source: use import (ADR-0016).',
        },
        {
          selector: "CallExpression[callee.property.name='defaultRandom']",
          message:
            'Ids are application-generated UUIDv7: use baseColumns() / $defaultFn(newId) (ADR-0003).',
        },
        {
          selector: 'Literal[value=/gen_random_uuid|uuid_generate_v4/i]',
          message: 'Ids are application-generated UUIDv7 (ADR-0003).',
        },
        {
          selector: 'TemplateElement[value.raw=/gen_random_uuid|uuid_generate_v4/i]',
          message: 'Ids are application-generated UUIDv7 (ADR-0003).',
        },
        {
          selector:
            "CallExpression[callee.name='timestamp'] > ObjectExpression > Property[key.name='withTimezone'] > Literal[value=false]",
          message: 'Timestamps are TIMESTAMPTZ (Spec §2.2).',
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
