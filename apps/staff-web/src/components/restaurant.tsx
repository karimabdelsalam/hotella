'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { card, field, localToday, type Run, shiftDate, useClock } from './restaurant-common';
import { RestaurantBooking } from './restaurant-booking';
import { RestaurantSetup } from './restaurant-setup';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { RestaurantBoard, RestaurantView, TableReservation, TableStatus } from '../lib/types';

const TONE: Record<TableStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  CONFIRMED: 'info',
  SEATED: 'success',
  COMPLETED: 'neutral',
  CANCELLED: 'neutral',
  NO_SHOW: 'danger',
};
type Tab = 'BOARD' | 'BOOK' | 'SETUP';

/**
 * À la carte restaurants for the hotel team (Spec Appendix B.1, BUILD_PLAN 14.3): the reservation board of a day
 * (seat, complete, no-show, cancel), a booking taken on the phone for a room, and the restaurants' setup — names in
 * every language, rules, the weekly sittings with their seats, and closed days. Each part shows only with its
 * permission. Logical properties only, so it mirrors in Arabic.
 */
export function RestaurantApp() {
  const t = useTranslations('staff.restaurant');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const clock = useClock();
  const { me, properties, propertyId, setPropertyId, failed } = usePropertiesWith(
    'restaurant.restaurant.read',
  );
  const { show: showBrand } = useStaffBrand();
  const [tab, setTab] = useState<Tab>('BOARD');
  const [date, setDate] = useState(localToday);
  const [board, setBoard] = useState<RestaurantBoard[] | null>(null);
  const [restaurants, setRestaurants] = useState<RestaurantView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  useEffect(() => showBrand(propertyId), [propertyId, showBrand]);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );
  useEffect(() => {
    if (failed) fail(failed);
  }, [failed, fail]);
  const can = useMemo(() => {
    const held = me && propertyId ? permissionsAt(me, propertyId) : new Set<string>();
    return {
      board: held.has('restaurant.reservation.read'),
      book: held.has('restaurant.reservation.manage'),
      override: held.has('restaurant.reservation.override'),
      setup: held.has('restaurant.restaurant.manage'),
    };
  }, [me, propertyId]);
  const tabs = (['BOARD', 'BOOK', 'SETUP'] as const).filter(
    (k) =>
      (k === 'BOARD' && can.board) || (k === 'BOOK' && can.book) || (k === 'SETUP' && can.setup),
  );
  const current = tabs.includes(tab) ? tab : (tabs[0] ?? null);

  const base = propertyId ? `/properties/${propertyId}` : null;
  const loadRestaurants = useCallback(async () => {
    if (!base) return;
    setRestaurants(await session.api<RestaurantView[]>(`${base}/restaurants`));
  }, [session, base]);
  const loadBoard = useCallback(async () => {
    if (!base || !can.board) return;
    setBoard(await session.api<RestaurantBoard[]>(`${base}/restaurant-reservations?date=${date}`));
  }, [session, base, date, can.board]);
  useEffect(() => {
    loadRestaurants().catch(fail);
  }, [loadRestaurants, fail]);
  useEffect(() => {
    loadBoard().catch(fail);
  }, [loadBoard, fail]);

  const run: Run = async (action, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  async function move(r: TableReservation, action: 'seat' | 'complete' | 'no-show' | 'cancel') {
    await run(async () => {
      await session.api(`${base}/restaurant-reservations/${r.id}/${action}`, {
        method: 'POST',
        body: { version: r.version },
      });
      await loadBoard();
    });
  }

  if (session.state !== 'signed-in') return <Header />;
  return (
    <>
      <Header />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 text-sm">
        <h1 className="text-base font-bold">{t('title')}</h1>
        {properties && properties.length > 1 && (
          <select
            aria-label={tStaff('inbox.property')}
            className="rounded-full border border-slate-300 bg-white px-3 py-1"
            value={propertyId ?? ''}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setBoard(null);
            }}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-1" role="tablist" aria-label={t('title')}>
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={current === k}
              onClick={() => setTab(k)}
              className={cx(
                'rounded-full px-3 py-1 text-sm font-semibold',
                current === k ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t(`tab.${k}`)}
            </button>
          ))}
        </div>
        {current === 'BOARD' && (
          <div className="ms-auto flex items-center gap-1">
            <Button
              variant="ghost"
              aria-label={t('previous_day')}
              onClick={() => setDate(shiftDate(date, -1))}
            >
              ‹
            </Button>
            <input
              type="date"
              aria-label={t('date')}
              className={field}
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
            <Button
              variant="ghost"
              aria-label={t('next_day')}
              onClick={() => setDate(shiftDate(date, 1))}
            >
              ›
            </Button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {properties && properties.length === 0 && (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      )}
      {base && current === 'BOARD' && board && (
        <main className="flex flex-col gap-4 p-4" aria-label={t('tab.BOARD')}>
          {board.length === 0 && (
            <p className={cx(card, 'text-sm text-slate-500')}>{t('no_restaurants')}</p>
          )}
          {board.map((r) => (
            <section
              key={r.id}
              className={cx(card, 'flex flex-col gap-3')}
              aria-labelledby={`b-${r.id}`}
              data-restaurant={r.code}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={`b-${r.id}`} className="text-lg font-bold">
                  {r.name}
                </h2>
                {r.status !== 'ACTIVE' && <Badge tone="warning">{t(`status.${r.status}`)}</Badge>}
                <span className="ms-auto text-sm text-slate-600">{clock.day(date)}</span>
              </div>
              {r.sittings.length === 0 && (
                <p className="text-sm text-slate-500">{t('closed_day')}</p>
              )}
              {r.sittings.map((s) => (
                <div key={s.sittingId} className="flex flex-col gap-2" data-sitting={s.startsAt}>
                  <div className="flex items-center gap-3">
                    <span className="w-16 shrink-0 font-bold">{clock.time(s.startsAt)}</span>
                    <div
                      className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100"
                      aria-hidden
                    >
                      <div
                        className={cx(
                          'h-full rounded-full',
                          s.free === 0 ? 'bg-red-500' : 'bg-emerald-500',
                        )}
                        style={{
                          inlineSize: `${Math.min(100, (s.booked / Math.max(1, s.seats)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="shrink-0 text-sm text-slate-600" data-testid="seats">
                      {t('seats', { booked: s.booked, seats: s.seats })}
                    </span>
                  </div>
                  {s.reservations.length > 0 && (
                    <ul className="flex flex-col divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
                      {s.reservations.map((x) => (
                        <li
                          key={x.id}
                          data-reservation={x.roomNumber ?? x.id}
                          className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                        >
                          {x.roomNumber && (
                            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-bold">
                              {x.roomNumber}
                            </span>
                          )}
                          <span className="font-semibold">{x.guestName ?? t('guest')}</span>
                          <span className="text-slate-600">
                            {t('people', { count: x.partySize })}
                          </span>
                          <Badge tone="neutral">{t(`channel.${x.channel}`)}</Badge>
                          {x.overridden && <Badge tone="warning">{t('overridden')}</Badge>}
                          <span className="ms-auto">
                            <Badge tone={TONE[x.status]}>{t(`table.${x.status}`)}</Badge>
                          </span>
                          {x.notes && <p className="w-full text-xs text-amber-800">{x.notes}</p>}
                          {can.book && (x.status === 'CONFIRMED' || x.status === 'SEATED') && (
                            <div className="flex w-full flex-wrap gap-1.5">
                              {x.status === 'CONFIRMED' && (
                                <>
                                  <Button disabled={busy} onClick={() => void move(x, 'seat')}>
                                    {t('seat')}
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() => void move(x, 'no-show')}
                                  >
                                    {t('no_show')}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() => void move(x, 'cancel')}
                                  >
                                    {t('cancel')}
                                  </Button>
                                </>
                              )}
                              {x.status === 'SEATED' && (
                                <Button
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => void move(x, 'complete')}
                                >
                                  {t('complete')}
                                </Button>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          ))}
        </main>
      )}
      {base && current === 'BOOK' && (
        <RestaurantBooking
          base={base}
          canOverride={can.override}
          busy={busy}
          run={run}
          onBooked={() => void loadBoard().catch(fail)}
        />
      )}
      {base && current === 'SETUP' && (
        <RestaurantSetup
          base={base}
          restaurants={restaurants}
          busy={busy}
          run={run}
          onChanged={async () => {
            await loadRestaurants();
            await loadBoard();
          }}
        />
      )}
    </>
  );
}
