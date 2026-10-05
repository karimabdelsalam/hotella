#!/usr/bin/env node
/**
 * Fails when a locale's keys differ from `en`, a message is not valid ICU, uses other arguments than `en`, or a plural
 * lacks one of its locale's CLDR categories (ADR-0022). Used by `pnpm locales:check` in CI.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { checkMessages, checkParity, findLocalesDir, loadCatalog, SUPPORTED_LOCALES } = require(
  join(here, '..', 'dist', 'catalog.js'),
);

const locales = process.argv[2] ? process.argv[2].split(',') : [...SUPPORTED_LOCALES];
const dir = findLocalesDir(process.env.LOCALES_DIR, process.cwd());
const catalog = loadCatalog(dir, locales);
const problems = [...checkParity(catalog, 'en'), ...checkMessages(catalog, 'en')];
if (problems.length) {
  console.error(`locales:check failed (${problems.length}):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `locales:check OK — ${locales.join(', ')} share ${Object.keys(catalog.en).length} keys (${dir})`,
);
