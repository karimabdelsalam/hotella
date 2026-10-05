'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { card, field, label, localToday, type Run, shiftDate, useClock } from './restaurant-common';
import { useSession } from '../lib/session';
import type { RestaurantAvailability, StayForBooking } from '../lib/types';

/**
 * A booking taken on the phone (or at the desk): find the room, pick the guest's stay, the restaurant, the night
 * and the sitting. The API applies the same rules as the guest app; past the stay's allowance or a full sitting,
 * a person with the override permission books anyway with a reason (audited).
 */
export function RestaurantBooking({
  base,
  canOverride,
  busy,
  run,
  onBooked,
}: {
  readonly base: string;
  readonly canOverride: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onBooked: () => void;
}) {
  const t = useTranslations('staff.restaurant');
  const session = useSession();
  const clock = useClock();
  const [room, setRoom] = useState('');
  const [stays, setStays] = useState<StayForBooking[] | null>(null);
  const [stay, setStay] = useState<StayForBooking | null>(null);
  const [restaurantId, setRestaurantId] = useState('');
  const [date, setDate] = useState('');
  const [day, setDay] = useState<RestaurantAvailability | null>(null);
  const [sittingId, setSittingId] = useState('');
  const [party, setParty] = useState(2);
  const [notes, setNotes] = useState('');
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');

  const firstNight = stay ? (stay.arrival > localToday() ? stay.arrival : localToday()) : '';
  const lastNight = stay ? shiftDate(stay.departure, -1) : '';

  useEffect(() => {
    if (!restaurantId || !date) return;
    let live = true;
    session
      .api<RestaurantAvailability[]>(`${base}/restaurants/availability?from=${date}&to=${date}`)
      .then((all) => live && setDay(all.find((r) => r.id === restaurantId) ?? null))
      .catch(() => live && setDay(null));
    return () => {
      live = false;
    };
  }, [session, base, restaurantId, date]);

  function choose(s: StayForBooking) {
    setStay(s);
    setParty(Math.max(1, s.partySize));
    setRestaurantId(s.allowance[0]?.restaurantId ?? '');
    setDate(s.arrival > localToday() ? s.arrival : localToday());
    setSittingId('');
  }

  const allowance = stay?.allowance.find((a) => a.restaurantId === restaurantId) ?? null;
  const sittings = day?.days[0]?.sittings ?? [];
  const sitting = sittings.find((s) => s.sittingId === sittingId) ?? null;
  const needsOverride = allowance?.remaining === 0 || (sitting !== null && sitting.free < party);

  async function book() {
    if (!stay || !sitting) return;
    const ok = await run(
      async () => {
        await session.api(`${base}/restaurant-reservations`, {
          method: 'POST',
          body: {
            restaurantId,
            sittingId: sitting.sittingId,
            serviceDate: date,
            partySize: party,
            stayId: stay.stayId,
            notes: notes.trim() || null,
            ...(override && reason.trim() ? { override: { reason: reason.trim() } } : {}),
          },
        });
      },
      t('booked', {
        room: stay.roomNumber,
        date: clock.day(date),
        time: clock.time(sitting.startsAt),
      }),
    );
    if (ok) {
      setNotes('');
      setOverride(false);
      setReason('');
      setSittingId('');
      setStays(null);
      setStay(null);
      setRoom('');
      onBooked();
    }
  }

  return (
    <main
      className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"
      aria-label={t('tab.BOOK')}
    >
      <section className={cx(card, 'flex flex-col gap-3')} aria-labelledby="find-title">
        <h2 id="find-title" className="font-bold">
          {t('find_room')}
        </h2>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!room.trim()) return;
            void run(async () => {
              setStay(null);
              setStays(
                await session.api<StayForBooking[]>(
                  `${base}/restaurant-reservations/stays?room=${encodeURIComponent(room.trim())}`,
                ),
              );
            });
          }}
        >
          <input
            aria-label={t('room')}
            placeholder={t('room')}
            className={cx(field, 'w-32')}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {t('find')}
          </Button>
        </form>
        {stays && stays.length === 0 && <p className="text-sm text-slate-500">{t('no_stay')}</p>}
        <ul className="flex flex-col gap-2">
          {stays?.map((s) => (
            <li key={s.stayId}>
              <button
                type="button"
                aria-pressed={stay?.stayId === s.stayId}
                onClick={() => choose(s)}
                data-stay={s.roomNumber}
                className={cx(
                  'flex w-full flex-col gap-1 rounded-xl p-3 text-start ring-1',
                  stay?.stayId === s.stayId
                    ? 'ring-2 ring-[var(--brand-primary,#0f4c81)]'
                    : 'ring-slate-200',
                )}
              >
                <span className="font-semibold">
                  {s.guestName ?? t('guest')} · {t('room_number', { room: s.roomNumber })}
                </span>
                <span className="text-xs text-slate-600">
                  {clock.day(s.arrival)} → {clock.day(s.departure)} ·{' '}
                  {t('nights', { count: s.nights })}
                </span>
                <span className="flex flex-wrap gap-1">
                  {s.allowance.map((a) => (
                    <Badge key={a.restaurantId} tone={a.remaining === 0 ? 'warning' : 'neutral'}>
                      {a.remaining === null
                        ? t('allowance_free', { name: a.name })
                        : t('allowance_left', { name: a.name, count: a.remaining })}
                    </Badge>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {stay && (
        <section className={cx(card, 'flex flex-col gap-3')} aria-labelledby="book-title">
          <h2 id="book-title" className="font-bold">
            {t('book_for', { name: stay.guestName ?? t('guest'), room: stay.roomNumber })}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>
              {t('restaurant')}
              <select
                className={field}
                value={restaurantId}
                onChange={(e) => {
                  setRestaurantId(e.target.value);
                  setSittingId('');
                }}
              >
                {stay.allowance.map((a) => (
                  <option key={a.restaurantId} value={a.restaurantId}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={label}>
              {t('date')}
              <input
                type="date"
                className={field}
                min={firstNight}
                max={lastNight}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setSittingId('');
                }}
              />
            </label>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-slate-600">{t('sitting')}</legend>
            {sittings.length === 0 && <p className="text-sm text-slate-500">{t('closed_day')}</p>}
            <div className="flex flex-wrap gap-2">
              {sittings.map((s) => (
                <button
                  key={s.sittingId}
                  type="button"
                  aria-pressed={s.sittingId === sittingId}
                  data-sitting={s.startsAt}
                  onClick={() => setSittingId(s.sittingId)}
                  className={cx(
                    'flex flex-col items-center rounded-xl px-4 py-2 text-sm font-semibold ring-1',
                    s.sittingId === sittingId
                      ? 'bg-slate-900 text-white ring-transparent'
                      : 'bg-white ring-slate-300',
                  )}
                >
                  {clock.time(s.startsAt)}
                  <span className="text-xs font-normal">{t('free', { count: s.free })}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <label className={label}>
              {t('party')}
              <input
                type="number"
                min={1}
                max={50}
                className={field}
                value={party}
                onChange={(e) => setParty(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className={label}>
              {t('notes')}
              <input
                className={field}
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>
          {needsOverride && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {allowance?.remaining === 0 ? t('allowance_used') : t('sitting_full')}
            </p>
          )}
          {canOverride && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                {t('override')}
              </label>
              {override && (
                <label className={label}>
                  {t('override_reason')}
                  <input
                    className={field}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
              )}
            </div>
          )}
          <Button
            disabled={busy || !sitting || (override && reason.trim().length < 3)}
            onClick={() => void book()}
          >
            {t('book')}
          </Button>
        </section>
      )}
    </main>
  );
}
