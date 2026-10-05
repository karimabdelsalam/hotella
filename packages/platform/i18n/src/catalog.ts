import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  isLiteralElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTagElement,
  type MessageFormatElement,
  parse,
} from '@formatjs/icu-messageformat-parser';

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

/** The user-facing languages (ADR-0022); `en` is the reference for keys. Arabic is the only right-to-left one. */
export const SUPPORTED_LOCALES = ['en', 'ar', 'it', 'ru', 'de'] as const;
export const RTL_LOCALES: readonly string[] = ['ar'];

interface MessageShape {
  readonly args: Set<string>;
  /** Plural and select arguments with the selectors each offers. */
  readonly choices: Map<string, { kind: 'plural' | 'select'; options: Set<string> }>;
}

function shapeOf(message: string): MessageShape {
  const shape: MessageShape = { args: new Set(), choices: new Map() };
  const walk = (nodes: readonly MessageFormatElement[]) => {
    for (const n of nodes) {
      if (isLiteralElement(n) || isPoundElement(n)) continue;
      if (isTagElement(n)) {
        walk(n.children);
        continue;
      }
      shape.args.add(n.value);
      if (isPluralElement(n) || isSelectElement(n)) {
        const kind = isPluralElement(n) ? 'plural' : 'select';
        const existing = shape.choices.get(n.value)?.options ?? new Set<string>();
        for (const [selector, option] of Object.entries(n.options)) {
          existing.add(selector);
          walk(option.value);
        }
        shape.choices.set(n.value, { kind, options: existing });
      }
    }
  };
  walk(parse(message));
  return shape;
}

/**
 * Beyond key parity (ADR-0022): every message is valid ICU, uses the same arguments as the reference, and each plural
 * offers `other` plus every CLDR plural category of its own locale (Russian one/few/many, Arabic zero/one/two/few/many,
 * Italian and German one). An exact `=0` stands in for `zero` (in CLDR it only ever means 0); no other exact selector
 * stands in for a category (Russian `one` is also 21, 31, …).
 */
export function checkMessages(catalog: Catalog, reference = 'en'): string[] {
  const problems: string[] = [];
  const ref = catalog[reference] ?? {};
  for (const [locale, entries] of Object.entries(catalog)) {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const [key, message] of Object.entries(entries)) {
      let shape: MessageShape;
      try {
        shape = shapeOf(message);
      } catch (err) {
        problems.push(`${locale}: "${key}" is not valid ICU: ${(err as Error).message}`);
        continue;
      }
      for (const [arg, choice] of shape.choices) {
        if (!choice.options.has('other'))
          problems.push(`${locale}: "${key}" — {${arg}, ${choice.kind}} has no "other"`);
        if (choice.kind === 'plural')
          for (const c of categories)
            if (!choice.options.has(c) && !(c === 'zero' && choice.options.has('=0')))
              problems.push(`${locale}: "${key}" — {${arg}, plural} lacks the "${c}" form`);
      }
      if (locale === reference || ref[key] === undefined) continue;
      let refShape: MessageShape;
      try {
        refShape = shapeOf(ref[key]);
      } catch {
        continue;
      }
      for (const a of refShape.args)
        if (!shape.args.has(a)) problems.push(`${locale}: "${key}" does not use {${a}}`);
      for (const a of shape.args)
        if (!refShape.args.has(a)) problems.push(`${locale}: "${key}" uses unknown {${a}}`);
    }
  }
  return problems;
}
