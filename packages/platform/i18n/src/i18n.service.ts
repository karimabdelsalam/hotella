import { IntlMessageFormat } from 'intl-messageformat';
import type { Catalog } from './catalog';

export type MessageParams = Record<string, string | number | boolean | Date | null | undefined>;

export interface I18nOptions {
  readonly catalog: Catalog;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  /** Called once per missing key so gaps surface in logs without flooding them. */
  readonly onMissing?: (key: string, locale: string) => void;
}

/**
 * ICU MessageFormat translator over the shared catalog. Same format as next-intl on the frontend, so a
 * key behaves identically in both tiers. Formatters are cached per (locale, key).
 */
export class I18nService {
  private readonly cache = new Map<string, IntlMessageFormat>();
  private readonly reported = new Set<string>();

  constructor(private readonly options: I18nOptions) {
    if (!options.catalog[options.defaultLocale])
      throw new Error(`Default locale "${options.defaultLocale}" is not in the catalog`);
  }

  get supportedLocales(): readonly string[] {
    return this.options.supportedLocales;
  }
  get defaultLocale(): string {
    return this.options.defaultLocale;
  }

  /** Normalizes `ar-EG` → `ar` when only the base is supported; unknown locales fall back to the default. */
  normalize(locale: string | null | undefined): string {
    if (!locale) return this.options.defaultLocale;
    const lower = locale.trim().replace('_', '-');
    if (this.options.supportedLocales.includes(lower)) return lower;
    const base = lower.split('-')[0]!;
    if (this.options.supportedLocales.includes(base)) return base;
    return this.options.defaultLocale;
  }

  /** The supported locale a tag maps to (`ar-EG` → `ar`), or null when nothing supported matches. */
  match(locale: string | null | undefined): string | null {
    if (!locale) return null;
    const lower = locale.trim().replace('_', '-');
    if (this.options.supportedLocales.includes(lower)) return lower;
    const base = lower.split('-')[0]!;
    return this.options.supportedLocales.includes(base) ? base : null;
  }

  has(key: string, locale?: string): boolean {
    const l = this.normalize(locale);
    return Boolean(
      this.options.catalog[l]?.[key] ?? this.options.catalog[this.options.defaultLocale]?.[key],
    );
  }

  /** Translates `namespace.key` with ICU params. Falls back to the default locale, then to the key itself. */
  t(key: string, params: MessageParams = {}, locale?: string): string {
    const l = this.normalize(locale);
    const message =
      this.options.catalog[l]?.[key] ?? this.options.catalog[this.options.defaultLocale]?.[key];
    if (message === undefined) {
      if (!this.reported.has(key)) {
        this.reported.add(key);
        this.options.onMissing?.(key, l);
      }
      return key;
    }
    const cacheKey = `${l}\u0000${key}`;
    let fmt = this.cache.get(cacheKey);
    if (!fmt) {
      fmt = new IntlMessageFormat(message, l);
      this.cache.set(cacheKey, fmt);
    }
    const out = fmt.format(
      params as Record<string, string | number | boolean | Date | null | undefined>,
    );
    return Array.isArray(out) ? out.join('') : String(out);
  }

  /** Text direction for layout decisions (RTL for Arabic, Hebrew, Persian, Urdu). */
  direction(locale?: string): 'ltr' | 'rtl' {
    const base = this.normalize(locale).split('-')[0];
    return base === 'ar' || base === 'he' || base === 'fa' || base === 'ur' ? 'rtl' : 'ltr';
  }
}
