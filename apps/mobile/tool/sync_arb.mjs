// Builds the app's Flutter ARB files from the shared ICU catalog (/locales, ADR-0009, ADR-0022, ADR-0023): the
// `mobile.*` keys of every locale become ARB messages with Dart-identifier keys (`mobile.home.welcome_plain` →
// `homeWelcomePlain`). ARB uses ICU syntax, so messages are copied as they are. `--check` fails when the committed
// ARB files are stale (CI).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), '..', '..');
const out = join(process.cwd(), 'lib', 'l10n');
const check = process.argv.includes('--check');
const NAMESPACE = 'mobile';
const TEMPLATE = 'en';

const locales = readdirSync(join(root, 'locales'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'locales', d.name, `${NAMESPACE}.json`)))
  .map((d) => d.name)
  .sort((a, b) => (a === TEMPLATE ? -1 : b === TEMPLATE ? 1 : a.localeCompare(b)));

/** `mobile.home.welcome_plain` → `homeWelcomePlain`. */
export function arbKey(key) {
  return key
    .slice(NAMESPACE.length + 1)
    .split(/[._]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** Top-level ICU arguments of a message: `{name}` → String, `{count, plural, …}` → num. */
function placeholders(message) {
  const found = {};
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (c === '{') {
      if (depth === 0) {
        const m = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*(\w+))?/.exec(message.slice(i));
        if (m)
          found[m[1]] =
            m[2] === 'plural' || m[2] === 'selectordinal' ? { type: 'num' } : { type: 'String' };
      }
      depth++;
    } else if (c === '}') depth--;
  }
  return found;
}

/**
 * Flutter's gen-l10n does not read the ICU `#` of a plural branch: it becomes the plural argument (`{count}`). Only a
 * `#` directly inside a branch of a plural is rewritten; nested arguments are left alone.
 */
export function flutterIcu(message) {
  let out = '';
  const stack = []; // per open brace: { arg, plural, branch }
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    const top = stack.at(-1);
    if (c === '{') {
      const m = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(plural|selectordinal)\s*,/.exec(
        message.slice(i),
      );
      stack.push(m ? { arg: m[1], plural: true } : { branch: top?.plural === true, arg: top?.arg });
      out += c;
    } else if (c === '}') {
      stack.pop();
      out += c;
    } else if (c === '#' && top?.branch) out += `{${top.arg}}`;
    else out += c;
  }
  return out;
}

let stale = false;
for (const locale of locales) {
  const catalog = JSON.parse(
    readFileSync(join(root, 'locales', locale, `${NAMESPACE}.json`), 'utf8'),
  );
  const arb = { '@@locale': locale };
  for (const [key, message] of Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b))) {
    const name = arbKey(key);
    arb[name] = flutterIcu(message);
    if (locale === TEMPLATE) {
      const args = placeholders(message);
      arb[`@${name}`] = {
        description: key,
        ...(Object.keys(args).length ? { placeholders: args } : {}),
      };
    }
  }
  const file = join(out, `app_${locale}.arb`);
  const text = `${JSON.stringify(arb, null, 2)}\n`;
  if (check) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      console.error(`stale: ${file} — run \`node tool/sync_arb.mjs\` in apps/mobile`);
      stale = true;
    }
  } else writeFileSync(file, text);
}
if (stale) process.exit(1);
console.log(`ARB ${check ? 'check OK' : 'written'} — ${locales.join(', ')}`);
