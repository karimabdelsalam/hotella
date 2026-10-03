import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { routing, RTL_LOCALES } from '../../../i18n/routing';

/** The installable app's manifest in the guest's language (PWA, ADR-0009). Neutral: the hotel's brand loads at run time. */
export async function GET(_req: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: requested } = await params;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: 'portal.app' });
  return Response.json(
    {
      name: t('title'),
      short_name: t('short_name'),
      lang: locale,
      dir: RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr',
      start_url: `/${locale}`,
      scope: '/',
      display: 'standalone',
      background_color: '#f8fafc',
      theme_color: '#1f2937',
    },
    { headers: { 'content-type': 'application/manifest+json' } },
  );
}
