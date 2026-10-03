import { Inject, Injectable, type NestMiddleware, Optional } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { I18nService } from './i18n.service';

export const CLS_LOCALE_KEY = 'locale';
export const CLS_LOCALE_SOURCE_KEY = 'locale_source';
/** Where the request locale came from, in chain order (Spec §79). */
export type LocaleSource = 'explicit' | 'preference' | 'detected' | 'property' | 'default';
export const LOCALE_QUERY_PARAM = 'lang';
export const LOCALE_HEADER = 'x-locale';

/**
 * Hooks for the later steps of the chain (Spec §79.3): the auth layer (Phase 1) supplies the actor's
 * preference and the property default; Phase 4 supplies the detected conversation language.
 */
export interface LocalePreferenceProvider {
  /** Explicit stored preference of the authenticated user/guest, if any. */
  actorPreference(req: Request): string | null | Promise<string | null>;
  /** Default locale of the property in scope, if any. */
  propertyDefault(req: Request): string | null | Promise<string | null>;
}
export const LOCALE_PREFERENCE_PROVIDER = Symbol('LOCALE_PREFERENCE_PROVIDER');

/** Parses `Accept-Language` by q-value and returns the first supported match. */
export function pickFromAcceptLanguage(
  header: string | undefined,
  normalize: (l: string) => string,
  supported: readonly string[],
): string | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: (tag ?? '').trim(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((r) => r.tag && r.tag !== '*' && !Number.isNaN(r.q) && r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const r of ranked) {
    const n = normalize(r.tag);
    const base = r.tag.toLowerCase().split('-')[0];
    if (supported.includes(n) && (n === r.tag.toLowerCase() || n === base)) return n;
  }
  return null;
}

/**
 * Resolution order (Spec §79.3): explicit choice (?lang= / X-Locale) → actor preference → detected
 * (Accept-Language) → property default → platform default. Result is stored in CLS for the request.
 */
@Injectable()
export class LocaleResolver implements NestMiddleware {
  constructor(
    private readonly i18n: I18nService,
    private readonly cls: ClsService,
    @Optional()
    @Inject(LOCALE_PREFERENCE_PROVIDER)
    private readonly prefs?: LocalePreferenceProvider | null,
  ) {}

  async resolve(req: Request): Promise<string> {
    return (await this.resolveWithSource(req)).locale;
  }

  async resolveWithSource(req: Request): Promise<{ locale: string; source: LocaleSource }> {
    const supported = this.i18n.supportedLocales;
    const explicit =
      (typeof req.query[LOCALE_QUERY_PARAM] === 'string'
        ? req.query[LOCALE_QUERY_PARAM]
        : undefined) ?? (req.headers[LOCALE_HEADER] as string | undefined);
    const explicitMatch = this.i18n.match(explicit);
    if (explicitMatch) return { locale: explicitMatch, source: 'explicit' };

    const pref = await this.prefs?.actorPreference(req);
    const prefMatch = this.i18n.match(pref);
    if (prefMatch) return { locale: prefMatch, source: 'preference' };

    const detected = pickFromAcceptLanguage(
      req.headers['accept-language'],
      (l) => this.i18n.normalize(l),
      supported,
    );
    if (detected) return { locale: detected, source: 'detected' };

    const property = await this.prefs?.propertyDefault(req);
    const propertyMatch = this.i18n.match(property);
    if (propertyMatch) return { locale: propertyMatch, source: 'property' };

    return { locale: this.i18n.defaultLocale, source: 'default' };
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const { locale, source } = await this.resolveWithSource(req);
    if (this.cls.isActive()) {
      this.cls.set(CLS_LOCALE_KEY, locale);
      this.cls.set(CLS_LOCALE_SOURCE_KEY, source);
    }
    res.setHeader('Content-Language', locale);
    next();
  }
}

/** Current request locale (or the default when outside a request). */
@Injectable()
export class CurrentLocale {
  constructor(
    private readonly cls: ClsService,
    private readonly i18n: I18nService,
  ) {}
  get(): string {
    return (
      (this.cls.isActive() ? this.cls.get<string>(CLS_LOCALE_KEY) : undefined) ??
      this.i18n.defaultLocale
    );
  }
  /**
   * The locale the requester actually asked for (explicit, profile preference or Accept-Language), or null when the
   * current locale is only a fallback. Lets a resource with its own default (a property) apply it before the
   * platform default.
   */
  requested(): string | null {
    if (!this.cls.isActive()) return null;
    const source = this.cls.get<LocaleSource | undefined>(CLS_LOCALE_SOURCE_KEY);
    return source === 'explicit' || source === 'preference' || source === 'detected'
      ? (this.cls.get<string>(CLS_LOCALE_KEY) ?? null)
      : null;
  }
  /** Translate in the current request's locale. */
  t(
    key: string,
    params?: Record<string, string | number | boolean | Date | null | undefined>,
  ): string {
    return this.i18n.t(key, params, this.get());
  }
}
