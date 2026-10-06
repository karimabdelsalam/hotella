import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AttributionFooter } from '@hotella/ui';
import { StaffShell } from '../../components/shell';
import { routing, RTL_LOCALES } from '../../i18n/routing';
import { MeProvider } from '../../lib/access';
import { StaffBrandProvider } from '../../lib/brand';
import { SessionProvider } from '../../lib/session';
import '@fontsource-variable/cairo';
import '../globals.css';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'staff.app' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

/** `lang` and `dir` follow the locale: Arabic is right-to-left everywhere (CLAUDE.md rule 8). */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return (
    <html lang={locale} dir={RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr'}>
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider>
          <SessionProvider>
            <MeProvider>
              <StaffBrandProvider>
                <StaffShell>{children}</StaffShell>
              </StaffBrandProvider>
            </MeProvider>
          </SessionProvider>
        </NextIntlClientProvider>
        <AttributionFooter />
      </body>
    </html>
  );
}
