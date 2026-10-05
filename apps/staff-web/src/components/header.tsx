'use client';

import { useLocale, useTranslations } from 'next-intl';
import { BrandMark, Button, cx, GlobeIcon, LOCALE_NAMES } from '@hotella/ui';
import { Link, usePathname, useRouter } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { holdsAnywhere, useEntitled, useMe } from '../lib/access';
import { logoUrl, useStaffBrand } from '../lib/brand';
import { useSession } from '../lib/session';

/** Each section, the permission that opens it (held at any property) and the licensed module it belongs to. */
const SECTIONS = [
  ['inbox', 'inbox.read', 'GUEST_EXPERIENCE'],
  ['housekeeping', 'hk.board.read', 'HOUSEKEEPING'],
  ['engineering', 'eng.work_order.read', 'ENGINEERING'],
  ['inspections', 'inspection.read', 'INSPECTIONS'],
  ['relations', 'complaint.read', 'GUEST_RELATIONS'],
  ['lostfound', 'lostfound.register', 'LOST_FOUND'],
  ['logbook', 'logbook.read', 'LOGBOOK'],
  ['restaurant', 'restaurant.restaurant.read', 'RESTAURANT'],
  ['arrivals', 'hk.arrivals.read', 'HOUSEKEEPING'],
  ['intelligence', 'ai.insight.read', 'AI_INTELLIGENCE'],
  ['branding', 'branding.manage', 'CORE'],
] as const;

/** The hotel's logo and name, the sections, the language and sign-out; logical spacing so it mirrors in Arabic. */
export function Header() {
  const t = useTranslations('staff.app');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const { brand } = useStaffBrand();
  const me = useMe();
  const entitled = useEntitled();
  const sections: ReadonlyArray<readonly [string, ...unknown[]]> = me
    ? [
        ...SECTIONS.filter(
          ([, permission, capability]) => holdsAnywhere(me, permission) && entitled(capability),
        ),
        // Planova's platform administrators: the control plane (Spec §63); hotel staff never see it.
        ...(me.user.isPlatformAdmin ? [['control'] as const] : []),
      ]
    : [];
  const name = brand?.displayName ?? t('title');
  return (
    <header className="border-b border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark name={name} logoUrl={logoUrl(brand)} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-bold" data-testid="hotel-name">
              {name}
            </span>
            {brand && <span className="text-xs text-slate-500">{t('title')}</span>}
          </div>
        </div>
        {session.state === 'signed-in' && sections.length > 0 && (
          <nav aria-label={t('sections')} className="flex flex-wrap gap-1 text-sm">
            {sections.map(([section]) => {
              const current = pathname.startsWith(`/${section}`);
              return (
                <Link
                  key={section}
                  href={`/${section}`}
                  aria-current={current ? 'page' : undefined}
                  className={cx(
                    'rounded-full px-3 py-1.5 font-semibold transition',
                    current ? 'bg-brand-soft text-brand' : 'text-slate-600 hover:bg-slate-100',
                  )}
                >
                  {t(`section_${section}`)}
                </Link>
              );
            })}
          </nav>
        )}
        <div className="ms-auto flex items-center gap-2">
          <label className="relative flex items-center">
            <GlobeIcon className="pointer-events-none absolute start-2.5 size-4 text-slate-500" />
            <select
              aria-label={t('language')}
              className="appearance-none rounded-full border border-slate-300 bg-white py-1.5 ps-8 pe-3 text-sm font-medium hover:bg-slate-50"
              value={locale}
              onChange={(e) => router.replace(pathname, { locale: e.target.value })}
            >
              {routing.locales.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
          </label>
          {session.state === 'signed-in' && (
            <Button
              variant="ghost"
              className="rounded-full"
              onClick={async () => {
                await session.signOut();
                router.replace('/login');
              }}
            >
              {t('sign_out')}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
