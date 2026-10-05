import { defineRouting } from 'next-intl/routing';
import { LOCALES } from '@hotella/ui';

/**
 * English, Arabic, Italian, Russian and German (Spec §79, ADR-0022); Arabic renders right-to-left. Activation links and room QR codes are
 * printed without a language (`/a/<token>`, `/q/<token>`): the middleware sends the guest to their browser's language.
 */
export const routing = defineRouting({ locales: LOCALES, defaultLocale: 'en' });
export type Locale = (typeof routing.locales)[number];
export { RTL_LOCALES } from '@hotella/ui';
