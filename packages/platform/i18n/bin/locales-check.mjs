#!/usr/bin/env node
/** Fails when en/ar key sets differ or a message is not valid ICU. Used by `pnpm locales:check` in CI. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { checkParity, findLocalesDir, loadCatalog } = require(
  join(here, '..', 'dist', 'catalog.js'),
);
const { IntlMessageFormat } = require('intl-messageformat');

const locales = (process.argv[2] ?? 'en,ar').split(',');
const dir = findLocalesDir(process.env.LOCALES_DIR, process.cwd());
const catalog = loadCatalog(dir, locales);
const problems = checkParity(catalog, 'en');
for (const [locale, entries] of Object.entries(catalog)) {
  for (const [key, message] of Object.entries(entries)) {
    try {
      new IntlMessageFormat(message, locale);
    } catch (err) {
      problems.push(`${locale}: "${key}" is not valid ICU: ${err.message}`);
    }
  }
}
if (problems.length) {
  console.error(`locales:check failed (${problems.length}):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `locales:check OK — ${locales.join(', ')} share ${Object.keys(catalog.en).length} keys (${dir})`,
);
