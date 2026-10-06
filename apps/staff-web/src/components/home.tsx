'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { type ComponentType, type SVGProps, useEffect, useMemo, useState } from 'react';
import { ArrivalIcon, Badge, BedIcon, ClockIcon, cx, DepartureIcon, DiningIcon } from '@hotella/ui';
import { Header } from './header';
import { localToday } from './restaurant-common';
import { Link, useRouter } from '../i18n/navigation';
import { permissionsAt, useEntitled, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { visibleActions } from '../lib/nav';
import { ApiError, useSession } from '../lib/session';
import type { RestaurantBoard, ServiceRequestRow, StayRow } from '../lib/types';

export const panel = 'rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5';
export const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  OPEN: 'warning',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

interface Today {
  inHouse: number | null;
  arrivals: StayRow[] | null;
  departures: number | null;
  requests: ServiceRequestRow[] | null;
  dining: number | null;
}

/**
 * The first screen after signing in: today at the hotel for this person's role (guests in house, arrivals and
 * departures, open guest requests, tonight's restaurant bookings), what they can start, and where to go. Each figure
 * shows only with the permission behind it; the numbers are counted here from the domain APIs, never guessed.
 */
export function HomeApp() {
  const t = useTranslations('staff.home');
  const tApp = useTranslations('staff.app');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const entitled = useEntitled();
  const { me, properties, propertyId, setPropertyId, failed } =
    usePropertiesWith('org.property.read');
  const { show: showBrand } = useStaffBrand();
  const [today, setToday] = useState<Today | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  useEffect(() => showBrand(propertyId), [propertyId, showBrand]);
  useEffect(() => {
    if (failed)
      setError(failed instanceof ApiError && failed.detail ? failed.detail : tStaff('inbox.error'));
  }, [failed, tStaff]);

  const held = useMemo(
    () => (me && propertyId ? permissionsAt(me, propertyId) : new Set<string>()),
    [me, propertyId],
  );
  const can = {
    stays: held.has('stay.read'),
    requests: held.has('request.read') && entitled('GUEST_EXPERIENCE'),
    dining: held.has('restaurant.reservation.read') && entitled('RESTAURANT'),
  };

  const { stays, requests, dining } = can;
  useEffect(() => {
    if (!propertyId) return;
    let live = true;
    const base = `/properties/${propertyId}`;
    const day = localToday();
    const quiet = <T,>(p: Promise<T>) => p.catch(() => null);
    void Promise.all([
      stays ? quiet(session.api<StayRow[]>(`${base}/stays?status=IN_HOUSE&limit=200`)) : null,
      stays ? quiet(session.api<StayRow[]>(`${base}/stays?status=EXPECTED&limit=200`)) : null,
      requests
        ? quiet(
            session.api<ServiceRequestRow[]>(
              `${base}/service-requests?status=OPEN,IN_PROGRESS&limit=50`,
            ),
          )
        : null,
      dining
        ? quiet(session.api<RestaurantBoard[]>(`${base}/restaurant-reservations?date=${day}`))
        : null,
    ]).then(([inHouse, expected, open, board]) => {
      if (!live) return;
      setToday({
        inHouse: inHouse?.length ?? null,
        arrivals: expected ? expected.filter((s) => s.expectedArrival <= day) : null,
        departures: inHouse ? inHouse.filter((s) => s.expectedDeparture <= day).length : null,
        requests: open,
        dining: board
          ? board
              .flatMap((r) => r.sittings.flatMap((s) => s.reservations))
              .filter((x) => x.status === 'CONFIRMED' || x.status === 'SEATED').length
          : null,
      });
    });
    return () => {
      live = false;
    };
  }, [session, propertyId, stays, requests, dining]);

  if (session.state !== 'signed-in') return <Header />;
  const actions = me ? visibleActions(me, entitled) : [];
  const name = me?.user.givenName ?? '';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-slate-500">
              {format.dateTime(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <h1 className="text-2xl font-bold tracking-tight">
              {t(`hello_${greeting}`, { name }).replace(/[\s,،]+$/u, '')}
            </h1>
          </div>
          {properties && properties.length > 1 && (
            <select
              aria-label={tStaff('inbox.property')}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={propertyId ?? ''}
              onChange={(e) => {
                setToday(null);
                setPropertyId(e.target.value);
              }}
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-800">
            {error}
          </p>
        )}

        {(can.stays || can.requests || can.dining) && (
          <ul
            className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
            aria-label={t('today')}
          >
            {can.stays && (
              <Stat
                icon={BedIcon}
                label={t('in_house')}
                value={today?.inHouse}
                href="/front-desk"
              />
            )}
            {can.stays && (
              <Stat
                icon={ArrivalIcon}
                label={t('arrivals')}
                value={today?.arrivals?.length}
                href="/front-desk"
              />
            )}
            {can.stays && (
              <Stat
                icon={DepartureIcon}
                label={t('departures')}
                value={today?.departures}
                href="/front-desk"
              />
            )}
            {can.requests && (
              <Stat
                icon={ClockIcon}
                label={t('open_requests')}
                value={today?.requests?.length}
                href="/front-desk"
                tone={today?.requests?.length ? 'warning' : undefined}
              />
            )}
            {can.dining && (
              <Stat
                icon={DiningIcon}
                label={t('dining_today')}
                value={today?.dining}
                href="/restaurant"
              />
            )}
          </ul>
        )}

        {actions.length > 0 && (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-bold text-slate-500">{t('start')}</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {actions.map((a) => {
                const Icon = a.icon;
                return (
                  <Link
                    key={a.key}
                    href={a.href}
                    className={cx(
                      panel,
                      'group flex items-center gap-3 p-4 font-semibold transition hover:ring-slate-300',
                    )}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                      <Icon className="size-5" />
                    </span>
                    <span className="text-sm leading-snug">{tApp(`new_${a.key}`)}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {can.requests && (
            <div className={cx(panel, 'flex flex-col')}>
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <h2 className="font-bold">{t('open_requests')}</h2>
              </div>
              {today?.requests && today.requests.length === 0 && (
                <p className="px-4 py-6 text-sm text-slate-500">{t('no_requests')}</p>
              )}
              <ul className="divide-y divide-slate-100">
                {today?.requests?.slice(0, 8).map((r) => (
                  <li key={r.id}>
                    <Link
                      href={
                        r.roomNumber
                          ? `/front-desk?room=${encodeURIComponent(r.roomNumber)}`
                          : '/front-desk'
                      }
                      className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
                    >
                      <span className="flex h-9 min-w-12 items-center justify-center rounded-lg bg-slate-100 px-2 text-sm font-bold">
                        {r.roomNumber ?? '—'}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-semibold">{r.serviceName}</span>
                        <span className="truncate text-xs text-slate-500">
                          {r.guestName ?? ''} · {format.relativeTime(new Date(r.createdAt))}
                        </span>
                      </span>
                      <Badge tone={STATUS_TONE[r.status]}>
                        {tStaff(`desk.status.${r.status}`)}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {can.stays && (
            <div className={cx(panel, 'flex flex-col')}>
              <div className="border-b border-slate-100 px-4 py-3">
                <h2 className="font-bold">{t('arriving')}</h2>
              </div>
              {today?.arrivals && today.arrivals.length === 0 && (
                <p className="px-4 py-6 text-sm text-slate-500">{t('no_arrivals')}</p>
              )}
              <ul className="divide-y divide-slate-100">
                {today?.arrivals?.slice(0, 8).map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex size-9 items-center justify-center rounded-full bg-sky-50 text-sky-700">
                      <ArrivalIcon className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-semibold">
                        {s.primaryGuest
                          ? [s.primaryGuest.givenName, s.primaryGuest.familyName]
                              .filter(Boolean)
                              .join(' ')
                          : t('guest')}
                      </span>
                      <span className="text-xs text-slate-500">
                        {t('party', { count: s.adults + s.children })}
                        {s.eta ? ` · ${t('eta', { time: s.eta.slice(0, 5) })}` : ''}
                      </span>
                    </span>
                    {s.primaryGuest?.vipCode && <Badge tone="info">{t('vip')}</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  href,
  tone,
}: {
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly label: string;
  readonly value: number | null | undefined;
  readonly href: string;
  readonly tone?: 'warning';
}) {
  return (
    <li>
      <Link
        href={href}
        className={cx(panel, 'flex h-full flex-col gap-3 p-4 transition hover:ring-slate-300')}
      >
        <span
          className={cx(
            'flex size-9 items-center justify-center rounded-xl',
            tone === 'warning' ? 'bg-amber-50 text-amber-700' : 'bg-brand-soft text-brand',
          )}
        >
          <Icon className="size-5" />
        </span>
        <span className="flex flex-col">
          <span className="text-2xl font-bold tabular-nums" data-stat={label}>
            {value ?? '–'}
          </span>
          <span className="text-xs font-semibold text-slate-500">{label}</span>
        </span>
      </Link>
    </li>
  );
}
