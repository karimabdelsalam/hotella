import { defineRouting } from 'next-intl/routing';

/** English and Arabic are first-class (Spec §79); Arabic renders right-to-left. */
export const routing = defineRouting({ locales: ['en', 'ar'], defaultLocale: 'en' });
export type Locale = (typeof routing.locales)[number];
export const RTL_LOCALES: readonly string[] = ['ar'];
