'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  BrandMark,
  cx,
  GlobeIcon,
  initials,
  LOCALE_NAMES,
  LogoutIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
} from '@hotella/ui';
import { useShell } from './shell';
import { Link, usePathname, useRouter } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { holdsAnywhere, useEntitled, useMe } from '../lib/access';
import { logoUrl, useStaffBrand } from '../lib/brand';
import { visibleActions } from '../lib/nav';
import { useSession } from '../lib/session';

/**
 * The top bar of every screen: the menu (phones), a room search for the desk, "+ New" for what staff start often,
 * the language and the person with sign-out. The hotel's mark sits here only when there is no side navigation
 * (signed out). Logical spacing, so it mirrors in Arabic.
 */
export function Header() {
  const t = useTranslations('staff.app');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const shell = useShell();
  const { brand } = useStaffBrand();
  const me = useMe();
  const entitled = useEntitled();
  const signedIn = session.state === 'signed-in';
  const name = brand?.displayName ?? t('title');
  const canSearch = signedIn && !!me && holdsAnywhere(me, 'stay.read');
  const actions = signedIn && me ? visibleActions(me, entitled) : [];
  const person = me?.user.givenName
    ? [me.user.givenName, me.user.familyName].filter(Boolean).join(' ')
    : (me?.user.email ?? '');

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="flex items-center gap-3 px-4 py-2.5">
        {shell.sidebar && (
          <button
            type="button"
            aria-label={t('menu')}
            aria-expanded={shell.open}
            onClick={() => shell.setOpen(!shell.open)}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
          >
            <MenuIcon />
          </button>
        )}
        {shell.sidebar ? (
          <span className="truncate font-bold lg:hidden">{name}</span>
        ) : (
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark name={name} logoUrl={logoUrl(brand)} />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-bold" data-testid="hotel-name">
                {name}
              </span>
              {brand && <span className="text-xs text-slate-500">{t('title')}</span>}
            </div>
          </div>
        )}
        {canSearch && (
          <form
            role="search"
            className="relative hidden max-w-xs flex-1 sm:block"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem('q') as HTMLInputElement;
              const room = input.value.trim();
              if (!room) return;
              input.value = '';
              router.push(`/front-desk?room=${encodeURIComponent(room)}`);
            }}
          >
            <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              name="q"
              type="search"
              aria-label={t('search')}
              placeholder={t('search_placeholder')}
              autoComplete="off"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 ps-9 pe-3 text-sm placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:outline-none"
            />
          </form>
        )}
        <div className="ms-auto flex items-center gap-2">
          {actions.length > 0 && <NewMenu actions={actions} />}
          <label className="relative flex items-center">
            <GlobeIcon className="pointer-events-none absolute start-2.5 size-4 text-slate-500" />
            <select
              aria-label={t('language')}
              className="appearance-none rounded-lg border border-slate-200 bg-white py-2 ps-8 pe-3 text-sm font-medium hover:bg-slate-50"
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
          {signedIn && (
            <>
              {person && (
                <span
                  title={person}
                  className="hidden size-9 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white md:flex"
                >
                  {initials(person)}
                </span>
              )}
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
                onClick={async () => {
                  await session.signOut();
                  router.replace('/login');
                }}
              >
                <LogoutIcon className="size-4" />
                <span className="hidden sm:inline">{t('sign_out')}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/** "+ New": what this person can start, in one place on every screen. */
function NewMenu({ actions }: { readonly actions: ReturnType<typeof visibleActions> }) {
  const t = useTranslations('staff.app');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-primary,#0f4c81)] px-3 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90"
      >
        <PlusIcon className="size-4" />
        <span className="hidden sm:inline">{t('new')}</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('new')}
          className="absolute end-0 top-full z-50 mt-2 w-64 rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-slate-900/10"
        >
          {actions.map((a) => {
            const Icon = a.icon;
            return (
              <Link
                key={a.key}
                role="menuitem"
                href={a.href}
                onClick={() => setOpen(false)}
                className={cx(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-700',
                  'hover:bg-slate-100',
                )}
              >
                <Icon className="size-[18px] text-slate-400" />
                {t(`new_${a.key}`)}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
