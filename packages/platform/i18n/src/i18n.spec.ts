import { describe, expect, it } from 'vitest';
import { checkParity, findLocalesDir, loadCatalog } from './catalog';
import { I18nService } from './i18n.service';
import { pickFromAcceptLanguage } from './locale-resolver';

const dir = findLocalesDir(undefined, process.cwd());
const catalog = loadCatalog(dir, ['en', 'ar']);
const i18n = new I18nService({ catalog, defaultLocale: 'en', supportedLocales: ['en', 'ar'] });

describe('shared catalog', () => {
  it('is found from a package directory and has en/ar parity', () => {
    expect(dir.endsWith('/locales')).toBe(true);
    expect(checkParity(catalog)).toEqual([]);
  });
  it('detects missing and extra keys', () => {
    expect(checkParity({ en: { 'a.b': 'x', 'a.c': 'y' }, ar: { 'a.b': 'x', 'a.d': 'z' } })).toEqual(
      ['ar: missing "a.c"', 'ar: extra "a.d" (not in en)'],
    );
  });
});

describe('I18nService', () => {
  it('formats ICU plurals with Arabic categories', () => {
    expect(i18n.t('common.items', { count: 0 }, 'en')).toBe('No items');
    expect(i18n.t('common.items', { count: 1 }, 'en')).toBe('1 item');
    expect(i18n.t('common.items', { count: 2 }, 'ar')).toBe('عنصران');
    // Node's ICU (CLDR 42+) uses Western digits for `ar` by default; Arabic-Indic digits become a per-property choice later.
    expect(i18n.t('common.items', { count: 5 }, 'ar')).toBe('5 عناصر');
    expect(i18n.t('common.items', { count: 11 }, 'ar')).toBe('11 عنصرًا');
  });
  it('normalizes regional variants and falls back to the default locale and then the key', () => {
    expect(i18n.normalize('ar-EG')).toBe('ar');
    expect(i18n.normalize('fr')).toBe('en');
    expect(i18n.match('fr')).toBeNull();
    expect(i18n.match('ar-SA')).toBe('ar');
    expect(i18n.t('errors.platform.not_found', {}, 'ar')).toBe('المورد المطلوب غير موجود.');
    const missing: string[] = [];
    const svc = new I18nService({
      catalog,
      defaultLocale: 'en',
      supportedLocales: ['en', 'ar'],
      onMissing: (k) => missing.push(k),
    });
    expect(svc.t('nope.key', {}, 'ar')).toBe('nope.key');
    svc.t('nope.key');
    expect(missing).toEqual(['nope.key']); // reported once
  });
  it('knows text direction', () => {
    expect(i18n.direction('ar')).toBe('rtl');
    expect(i18n.direction('en')).toBe('ltr');
  });
});

describe('Accept-Language', () => {
  const norm = (l: string): string => i18n.normalize(l);
  it('picks the best supported language by q-value', () => {
    expect(pickFromAcceptLanguage('fr-FR, ar;q=0.8, en;q=0.9', norm, ['en', 'ar'])).toBe('en');
    expect(pickFromAcceptLanguage('ar-EG,ar;q=0.9,en;q=0.5', norm, ['en', 'ar'])).toBe('ar');
    expect(pickFromAcceptLanguage('de', norm, ['en', 'ar'])).toBeNull();
    expect(pickFromAcceptLanguage(undefined, norm, ['en', 'ar'])).toBeNull();
  });
});
