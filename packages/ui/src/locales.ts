/**
 * The languages of the web apps (ADR-0022), in menu order, each named in its own language. Arabic is the only
 * right-to-left one. The server side keeps the same list in `@hotella/platform-i18n` (`SUPPORTED_LOCALES`).
 */
export const LOCALES = ['en', 'ar', 'it', 'ru', 'de'] as const;
export type Locale = (typeof LOCALES)[number];
export const RTL_LOCALES: readonly string[] = ['ar'];
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  ar: 'العربية',
  it: 'Italiano',
  ru: 'Русский',
  de: 'Deutsch',
};
