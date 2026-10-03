import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/** Locale routing (`/en/…`, `/ar/…`); the BFF and the API proxy are not localized. */
export default createMiddleware(routing);

export const config = { matcher: ['/((?!bff|hotella|_next|.*\\..*).*)'] };
