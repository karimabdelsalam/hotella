import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Catalog = Readonly<Record<string, Readonly<Record<string, string>>>>; // locale → global flat key → message

/**
 * Finds the shared `/locales` directory: an explicit path, or the nearest ancestor of `start` containing
 * `locales/en`. Works in dev (cwd = app dir), in CI (repo root) and in containers (/app).
 */
export function findLocalesDir(explicit?: string, start: string = process.cwd()): string {
  if (explicit) {
    if (!existsSync(join(explicit, 'en')))
      throw new Error(`LOCALES_DIR "${explicit}" has no "en" folder`);
    return resolve(explicit);
  }
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'locales');
    if (existsSync(join(candidate, 'en'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find a "locales/en" directory above ${start}; set LOCALES_DIR`);
}

/** Loads every `<locale>/*.json`. Files only organize keys; keys are global and must be unique across files. */
export function loadCatalog(localesDir: string, locales: readonly string[]): Catalog {
  const out: Record<string, Record<string, string>> = {};
  for (const locale of locales) {
    const dir = join(localesDir, locale);
    if (!existsSync(dir)) throw new Error(`Locale folder missing: ${dir}`);
    const flat: Record<string, string> = {};
    const owner: Record<string, string> = {};
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string')
          throw new Error(`${locale}/${file}: value of "${k}" must be a string`);
        if (k in flat)
          throw new Error(
            `${locale}: key "${k}" defined in both ${owner[k]} and ${file}; keys are global`,
          );
        flat[k] = v;
        owner[k] = file;
      }
    }
    out[locale] = flat;
  }
  return out;
}

/** Key sets must match across locales (Spec §79.1 parity). Returns problems, empty when consistent. */
export function checkParity(catalog: Catalog, reference = 'en'): string[] {
  const problems: string[] = [];
  const ref = catalog[reference];
  if (!ref) return [`reference locale "${reference}" missing`];
  const refKeys = new Set(Object.keys(ref));
  for (const [locale, entries] of Object.entries(catalog)) {
    if (locale === reference) continue;
    const keys = new Set(Object.keys(entries));
    for (const k of refKeys) if (!keys.has(k)) problems.push(`${locale}: missing "${k}"`);
    for (const k of keys)
      if (!refKeys.has(k)) problems.push(`${locale}: extra "${k}" (not in ${reference})`);
  }
  return problems;
}
