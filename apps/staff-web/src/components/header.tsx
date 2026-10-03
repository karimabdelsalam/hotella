'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@hotella/ui';
import { Link, usePathname, useRouter } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { useSession } from '../lib/session';

const NAMES: Record<string, string> = { en: 'English', ar: 'العربية' };

export function Header() {
  const t = useTranslations('staff.app');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
      <span className="font-semibold">{t('title')}</span>
      {session.state === 'signed-in' && (
        <nav aria-label={t('sections')} className="flex gap-3 text-sm">
          {(['inbox', 'housekeeping'] as const).map((section) => (
            <Link
              key={section}
              href={`/${section}`}
              aria-current={pathname.startsWith(`/${section}`) ? 'page' : undefined}
              className={pathname.startsWith(`/${section}`) ? 'font-semibold' : 'text-slate-600'}
            >
              {t(`section_${section}`)}
            </Link>
          ))}
        </nav>
      )}
      <div className="ms-auto flex items-center gap-2">
        <label className="flex items-center gap-1 text-sm text-slate-600">
          <span className="sr-only">{t('language')}</span>
          <select
            aria-label={t('language')}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
            value={locale}
            onChange={(e) => router.replace(pathname, { locale: e.target.value })}
          >
            {routing.locales.map((l) => (
              <option key={l} value={l}>
                {NAMES[l] ?? l}
              </option>
            ))}
          </select>
        </label>
        {session.state === 'signed-in' && (
          <Button
            variant="ghost"
            onClick={async () => {
              await session.signOut();
              router.replace('/login');
            }}
          >
            {t('sign_out')}
          </Button>
        )}
      </div>
    </header>
  );
}
