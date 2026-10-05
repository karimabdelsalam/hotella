// Builds the app's next-intl messages from the shared ICU catalog (/locales, ADR-0009): the flat `staff.*` keys (and
// `ai.*`, for insight reasons and actions) become nested objects (`staff.inbox.title` → { staff: { inbox: { title } } }).
// Generated files are not committed.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const NAMESPACES = ['staff', 'ai'];
// Every language of the shared catalog that has this app's namespaces (ADR-0022).
const LOCALES = readdirSync(join(root, 'locales'), { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      NAMESPACES.every((ns) => existsSync(join(root, 'locales', d.name, `${ns}.json`))),
  )
  .map((d) => d.name);

for (const locale of LOCALES) {
  const nested = {};
  for (const ns of NAMESPACES) {
    const flat = JSON.parse(readFileSync(join(root, 'locales', locale, `${ns}.json`), 'utf8'));
    for (const [key, value] of Object.entries(flat)) {
      const parts = key.split('.');
      let node = nested;
      for (const part of parts.slice(0, -1)) node = node[part] ??= {};
      node[parts.at(-1)] = value;
    }
  }
  const out = join(here, '..', 'src', 'messages', `${locale}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(nested, null, 2)}\n`);
}
