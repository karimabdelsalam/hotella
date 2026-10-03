import { defineRouting } from 'next-intl/routing';

/**
 * English and Arabic are first-class (Spec §79); Arabic renders right-to-left. Activation links and room QR codes are
 * printed without a language (`/a/<token>`, `/q/<token>`): the middleware sends the guest to their browser's language.
 */
export const routing = defineRouting({ locales: ['en', 'ar'], defaultLocale: 'en' });
export type Locale = (typeof routing.locales)[number];
export const RTL_LOCALES: readonly string[] = ['ar'];
