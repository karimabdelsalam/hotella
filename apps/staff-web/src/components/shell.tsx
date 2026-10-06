'use client';

import { useTranslations } from 'next-intl';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { BrandMark, CloseIcon, cx, HomeIcon } from '@hotella/ui';
import { Link, usePathname } from '../i18n/navigation';
import { useEntitled, useMe } from '../lib/access';
import { logoUrl, useStaffBrand } from '../lib/brand';
import { type NavItem, visibleNav } from '../lib/nav';
import { useSession } from '../lib/session';

interface Shell {
  /** Whether the side navigation is shown (signed in, not on the sign-in or invitation pages). */
  readonly sidebar: boolean;
  readonly open: boolean;
  setOpen(open: boolean): void;
}

const ShellContext = createContext<Shell>({
  sidebar: false,
  open: false,
  setOpen: () => undefined,
});

export function useShell(): Shell {
  return useContext(ShellContext);
}

const NEXT_KEY = 'hotella.staff.next';
const OPEN_PAGES = ['/login', '/invite'];

/** Where a signed-out person was going, to return there after signing in (per tab; never anything sensitive). */
export function takeNextPath(): string | null {
  try {
    const next = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
  } catch {
    return null;
  }
}

/**
 * The application frame: the hotel's mark and the screens grouped by department on the start side (a drawer on
 * phones), the page on the other. Logical properties only, so it mirrors in Arabic (rule 8).
 */
export function StaffShell({ children }: { readonly children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const openPage = OPEN_PAGES.some((p) => pathname.startsWith(p));
  const sidebar = session.state === 'signed-in' && !openPage;

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (session.state !== 'anonymous' || openPage) return;
    try {
      sessionStorage.setItem(NEXT_KEY, pathname);
    } catch {
      // Storage may be blocked; the person lands on the home page instead.
    }
  }, [session.state, openPage, pathname]);

  return (
    <ShellContext.Provider value={{ sidebar, open, setOpen }}>
      <div className="flex min-h-0 flex-1">
        {sidebar && <Sidebar open={open} onClose={() => setOpen(false)} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </ShellContext.Provider>
  );
}

function Sidebar({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const t = useTranslations('staff.app');
  const pathname = usePathname();
  const me = useMe();
  const entitled = useEntitled();
  const { brand } = useStaffBrand();
  const name = brand?.displayName ?? t('title');
  const groups = me ? visibleNav(me, entitled) : [];
  const home: NavItem = {
    key: 'home',
    href: '/home',
    permission: '',
    capability: 'CORE',
    icon: HomeIcon,
  };

  return (
    <>
      {open && (
        <div
          aria-hidden
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        data-testid="sidebar"
        className={cx(
          'z-40 w-64 shrink-0 flex-col border-e border-slate-200 bg-white',
          'lg:sticky lg:top-0 lg:flex lg:h-screen',
          open ? 'fixed inset-y-0 start-0 flex shadow-2xl' : 'hidden',
        )}
      >
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
          <BrandMark name={name} logoUrl={logoUrl(brand)} />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate font-bold" data-testid="hotel-name">
              {name}
            </span>
            {brand && <span className="truncate text-xs text-slate-500">{t('title')}</span>}
          </div>
          <button
            type="button"
            aria-label={t('close_menu')}
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
          >
            <CloseIcon className="size-5" />
          </button>
        </div>
        <nav
          aria-label={t('sections')}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-4 text-sm"
        >
          <ul>
            <Item item={home} pathname={pathname} label={t('section_home')} />
          </ul>
          {groups.map((g) => (
            <div key={g.key} className="flex flex-col gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-bold tracking-wide text-slate-400 uppercase">
                {t(`group_${g.key}`)}
              </p>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((item) => (
                  <Item
                    key={item.key}
                    item={item}
                    pathname={pathname}
                    label={t(`section_${item.key}`)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

function Item({
  item,
  pathname,
  label,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly label: string;
}) {
  const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={current ? 'page' : undefined}
        className={cx(
          'flex items-center gap-3 rounded-lg px-3 py-2 font-semibold transition',
          current
            ? 'bg-brand-soft text-brand'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        )}
      >
        <Icon className={cx('size-[18px] shrink-0', current ? '' : 'text-slate-400')} />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}
