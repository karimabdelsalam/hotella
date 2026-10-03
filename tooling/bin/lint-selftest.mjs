#!/usr/bin/env node
/**
 * Proves that the lint rules actually fail on the forbidden patterns (Gate A evidence).
 * Each fixture must produce at least one error from the expected rule.
 */
import { ESLint } from 'eslint';

const cases = [
  {
    file: 'tooling/lint-fixtures/packages/domain/guest/src/cross-import.ts',
    rule: 'no-restricted-imports',
  },
  {
    file: 'tooling/lint-fixtures/packages/platform/x/src/imports-domain.ts',
    rule: 'no-restricted-imports',
  },
  { file: 'tooling/lint-fixtures/process-env.ts', rule: 'no-restricted-properties' },
  { file: 'tooling/lint-fixtures/console-log.ts', rule: 'no-console' },
  { file: 'tooling/lint-fixtures/require-and-dirname.ts', rule: 'no-restricted-globals' },
];

const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs', ignore: false });
let ok = true;
for (const c of cases) {
  const [result] = await eslint.lintFiles([c.file]);
  const rules = new Set(result.messages.map((m) => m.ruleId));
  const hit = rules.has(c.rule);
  console.log(
    `${hit ? 'PASS' : 'FAIL'}  ${c.file}  expected ${c.rule}  got [${[...rules].join(', ')}]`,
  );
  if (!hit) ok = false;
}
process.exit(ok ? 0 : 1);
