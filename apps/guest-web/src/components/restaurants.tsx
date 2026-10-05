'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Badge, Button, cx } from '@hotella/ui';
import { api, ApiError } from '../lib/api';
import type { GuestReservation, GuestRestaurant, ReservationStatus } from '../lib/types';
import { SignedOut, useGuest } from './home';
import { BackLink, Card, ErrorText, Page, SectionTitle, TopBar } from './ui';

const TONE: Record<ReservationStatus, 'info' | 'success' | 'neutral' | 'warning'> = {
  CONFIRMED: 'info',
  SEATED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  NO_SHOW: 'warning',
};

/** Hotel-local dates and times (no time zone shift): `2026-10-06`, `21:00`. */
function useDates() {
  const format = useFormatter();
  return {
    day: (date: string) =>
      format.dateTime(new Date(`${date}T12:00:00Z`), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
    time: (clock: string) =>
      format.dateTime(new Date(`1970-01-01T${clock}:00Z`), {
        timeStyle: 'short',
        timeZone: 'UTC',
      }),
  };
}

/**
 * À la carte restaurants for the guest (Spec Appendix B.1): what can still be booked during the stay, a booking in
 * three taps (date, time, guests), and the guest's own reservations. The allowance, seats and cut-off are the API's —
 * this screen only shows them. Logical properties only, so it mirrors in Arabic.
 */
export function Restaurants() {
  const t = useTranslations('portal.restaurant');
  const locale = useLocale();
  const me = useGuest();
  const dates = useDates();
  const [restaurants, setRestaurants] = useState<readonly GuestRestaurant[] | null>(null);
  const [mine, setMine] = useState<readonly GuestReservation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [offer, reservations] = await Promise.all([
      api<{ restaurants: GuestRestaurant[] }>('guest/restaurants', locale),
      api<GuestReservation[]>('guest/restaurant-reservations', locale),
    ]);
    setRestaurants(offer.restaurants);
    setMine(reservations);
  }, [locale]);

  useEffect(() => {
    if (!me || me === 'signed-out') return;
    load().catch(() => setRestaurants([]));
  }, [me, load]);

  const fail = (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : t('error'));
  const upcoming = mine.filter((r) => r.status === 'CONFIRMED' || r.status === 'SEATED');

  if (me === 'signed-out') return <SignedOut />;
  return (
    <>
      <TopBar title={me?.property?.name} />
      <Page>
        <BackLink>{t('back')}</BackLink>
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-slate-600">{t('intro')}</p>
        </div>
        {notice && (
          <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        {upcoming.length > 0 && (
          <section aria-labelledby="my-tables" className="flex flex-col gap-2">
            <SectionTitle id="my-tables">{t('mine')}</SectionTitle>
            <ul className="flex flex-col gap-2">
              {upcoming.map((r) => (
                <li
                  key={r.id}
                  data-reservation={r.id}
                  className="flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-slate-900/5"
                >
                  <span className="flex min-w-0 flex-1 flex-col text-start">
                    <span className="font-semibold">{r.restaurant?.name}</span>
                    <span className="text-sm text-slate-600">
                      {dates.day(r.serviceDate)} · {dates.time(r.startsAt)} ·{' '}
                      {t('people', { count: r.partySize })}
                    </span>
                  </span>
                  <Badge tone={TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
                  {r.status === 'CONFIRMED' && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        api(`guest/restaurant-reservations/${r.id}/cancel`, locale, {
                          method: 'POST',
                        })
                          .then(() => setNotice(t('cancelled_notice')))
                          .then(load)
                          .catch(fail);
                      }}
                    >
                      {t('cancel')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {restaurants && restaurants.length === 0 && (
          <p className="text-sm text-slate-500">{t('empty')}</p>
        )}
        {restaurants?.map((r) => (
          <RestaurantCard
            key={r.id}
            restaurant={r}
            onBooked={(message) => {
              setError(null);
              setNotice(message);
              void load().catch(() => undefined);
            }}
            onError={(e) => {
              setNotice(null);
              fail(e);
            }}
          />
        ))}
      </Page>
    </>
  );
}

function RestaurantCard({
  restaurant: r,
  onBooked,
  onError,
}: {
  readonly restaurant: GuestRestaurant;
  readonly onBooked: (message: string) => void;
  readonly onError: (e: unknown) => void;
}) {
  const t = useTranslations('portal.restaurant');
  const locale = useLocale();
  const dates = useDates();
  const open = useMemo(() => r.days.filter((d) => d.sittings.some((s) => s.bookable)), [r.days]);
  const [date, setDate] = useState<string | null>(null);
  const [sittingId, setSittingId] = useState<string | null>(null);
  const [party, setParty] = useState(Math.min(2, r.maxParty));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const day = open.find((d) => d.date === date) ?? open[0] ?? null;
  const sitting = day?.sittings.find((s) => s.sittingId === sittingId && s.bookable) ?? null;
  const left = r.allowance.remaining;
  const canBook = left === null || left > 0;
  const maxParty = Math.max(r.minParty, Math.min(r.maxParty, sitting?.free ?? r.maxParty));

  async function book() {
    if (!day || !sitting) return;
    setBusy(true);
    try {
      await api('guest/restaurant-reservations', locale, {
        body: {
          restaurantId: r.id,
          sittingId: sitting.sittingId,
          serviceDate: day.date,
          partySize: Math.min(party, maxParty),
          notes: notes.trim() || null,
        },
      });
      setSittingId(null);
      setNotes('');
      onBooked(
        t('booked', {
          name: r.name,
          date: dates.day(day.date),
          time: dates.time(sitting.startsAt),
        }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <article aria-labelledby={`r-${r.id}`} data-restaurant={r.id} className="flex flex-col gap-3">
        <div>
          <h2 id={`r-${r.id}`} className="text-lg font-bold">
            {r.name}
          </h2>
          {r.description && <p className="mt-1 text-sm text-slate-600">{r.description}</p>}
          {r.dressCode && (
            <p className="mt-1 text-xs text-slate-500">{t('dress_code', { code: r.dressCode })}</p>
          )}
          {left !== null && (
            <p className="mt-2 text-sm font-medium text-slate-700" data-allowance={left}>
              {left > 0 ? t('allowance', { count: left }) : t('allowance_used')}
            </p>
          )}
        </div>
        {canBook && open.length === 0 && <p className="text-sm text-slate-500">{t('no_dates')}</p>}
        {canBook && day && (
          <>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-semibold text-slate-700">{t('date')}</legend>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {open.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    aria-pressed={d.date === day.date}
                    onClick={() => {
                      setDate(d.date);
                      setSittingId(null);
                    }}
                    className={cx(
                      'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition',
                      d.date === day.date
                        ? 'bg-brand text-white ring-transparent'
                        : 'bg-white text-slate-700 ring-slate-300',
                    )}
                  >
                    {dates.day(d.date)}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-semibold text-slate-700">{t('time')}</legend>
              <div className="flex flex-wrap gap-2">
                {day.sittings.map((s) => (
                  <button
                    key={s.sittingId}
                    type="button"
                    disabled={!s.bookable}
                    aria-pressed={s.sittingId === sitting?.sittingId}
                    data-sitting={s.startsAt}
                    onClick={() => setSittingId(s.sittingId)}
                    className={cx(
                      'flex flex-col items-center rounded-xl px-4 py-2 text-sm font-semibold ring-1 transition disabled:opacity-40',
                      s.sittingId === sitting?.sittingId
                        ? 'bg-brand text-white ring-transparent'
                        : 'bg-white text-slate-800 ring-slate-300',
                    )}
                  >
                    {dates.time(s.startsAt)}
                    {!s.bookable && <span className="text-xs font-normal">{t('unavailable')}</span>}
                  </button>
                ))}
              </div>
            </fieldset>
            {sitting && (
              <div className="flex flex-col gap-3">
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-semibold text-slate-700">{t('party')}</span>
                  <select
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-base"
                    value={Math.min(party, maxParty)}
                    onChange={(e) => setParty(Number(e.target.value))}
                  >
                    {Array.from(
                      { length: maxParty - r.minParty + 1 },
                      (_, i) => r.minParty + i,
                    ).map((n) => (
                      <option key={n} value={n}>
                        {t('people', { count: n })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-semibold text-slate-700">{t('notes')}</span>
                  <input
                    value={notes}
                    maxLength={500}
                    onChange={(e) => setNotes(e.target.value)}
                    className="rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-start"
                  />
                </label>
                <Button disabled={busy} onClick={() => void book()}>
                  {t('book')}
                </Button>
              </div>
            )}
          </>
        )}
      </article>
    </Card>
  );
}
