'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, cx, LOCALE_NAMES, LOCALES } from '@hotella/ui';
import { card, field, label, localToday, type Run, useClock } from './restaurant-common';
import { useSession } from '../lib/session';
import type { RestaurantDetail, RestaurantView } from '../lib/types';

type Row = { weekday: number; startsAt: string; seats: number };
const WEEK = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * Restaurants' setup: a new restaurant starts as a draft; its names per language, party sizes, how far ahead and
 * until when guests may book, whether the stay allowance applies, the weekly sittings with their seats (a new
 * schedule applies from a date, bookings already made keep their sitting) and closed days or sittings.
 */
export function RestaurantSetup({
  base,
  restaurants,
  busy,
  run,
  onChanged,
}: {
  readonly base: string;
  readonly restaurants: readonly RestaurantView[];
  readonly busy: boolean;
  readonly run: Run;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslations('staff.restaurant');
  const locale = useLocale();
  const session = useSession();
  const clock = useClock();
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RestaurantDetail | null>(null);
  const [draft, setDraft] = useState({ code: '', name: '' });
  const [rules, setRules] = useState({
    minParty: 1,
    maxParty: 8,
    bookDaysAhead: 7,
    guestCutoffMinutes: 120,
    allowanceApplies: true,
  });
  const [names, setNames] = useState<
    Record<string, { name: string; description: string; dressCode: string }>
  >({});
  const [rows, setRows] = useState<Row[]>([]);
  const [fromDate, setFromDate] = useState(localToday);
  const [closure, setClosure] = useState({ onDate: '', sittingId: '', reason: '' });

  const open = useCallback(
    async (id: string) => {
      const d = await session.api<RestaurantDetail>(`${base}/restaurants/${id}`);
      setSelected(id);
      setDetail(d);
      setRules({
        minParty: d.minParty,
        maxParty: d.maxParty,
        bookDaysAhead: d.bookDaysAhead,
        guestCutoffMinutes: d.guestCutoffMinutes,
        allowanceApplies: d.allowanceApplies,
      });
      setNames(
        Object.fromEntries(
          LOCALES.map((l) => {
            const tr = d.translations.find((x) => x.locale === l);
            return [
              l,
              {
                name: tr?.name ?? '',
                description: tr?.description ?? '',
                dressCode: tr?.dressCode ?? '',
              },
            ];
          }),
        ),
      );
      setRows(
        d.sittings.map((s) => ({ weekday: s.weekday, startsAt: s.startsAt, seats: s.seats })),
      );
    },
    [session, base],
  );
  useEffect(() => {
    if (!selected && restaurants[0]) void open(restaurants[0].id).catch(() => undefined);
  }, [selected, restaurants, open]);

  const refresh = async () => {
    if (selected) await open(selected);
    await onChanged();
  };

  return (
    <main
      className="grid gap-4 p-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]"
      aria-label={t('tab.SETUP')}
    >
      <section className="flex flex-col gap-3" aria-labelledby="restaurants-title">
        <h2 id="restaurants-title" className="sr-only">
          {t('restaurants')}
        </h2>
        <ul className="flex flex-col gap-2">
          {restaurants.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-pressed={selected === r.id}
                onClick={() => void open(r.id)}
                className={cx(
                  card,
                  'flex w-full items-center gap-2 text-start',
                  selected === r.id && 'ring-2 ring-[var(--brand-primary,#0f4c81)]',
                )}
              >
                <span className="font-semibold">{r.name || r.code}</span>
                <span className="ms-auto">
                  <Badge tone={r.status === 'ACTIVE' ? 'success' : 'warning'}>
                    {t(`status.${r.status}`)}
                  </Badge>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className={cx(card, 'flex flex-col gap-2')}
          aria-labelledby="new-title"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const created = await session.api<RestaurantView>(`${base}/restaurants`, {
                method: 'POST',
                body: {
                  code: draft.code.trim().toUpperCase(),
                  translations: [{ locale, name: draft.name.trim() }],
                },
              });
              setDraft({ code: '', name: '' });
              await onChanged();
              await open(created.id);
            }, t('created'));
          }}
        >
          <h3 id="new-title" className="text-sm font-bold">
            {t('new_restaurant')}
          </h3>
          <label className={label}>
            {t('code')}
            <input
              className={field}
              required
              pattern="[A-Za-z][A-Za-z0-9_]{1,39}"
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </label>
          <label className={label}>
            {t('name_in', {
              language: LOCALE_NAMES[locale as keyof typeof LOCALE_NAMES] ?? locale,
            })}
            <input
              className={field}
              required
              maxLength={120}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t('create')}
          </Button>
        </form>
      </section>

      {detail && (
        <section className="flex flex-col gap-4" aria-labelledby="detail-title">
          <div className={cx(card, 'flex flex-wrap items-center gap-2')}>
            <h2 id="detail-title" className="text-lg font-bold">
              {detail.name || detail.code}
            </h2>
            <Badge tone={detail.status === 'ACTIVE' ? 'success' : 'warning'}>
              {t(`status.${detail.status}`)}
            </Badge>
            <span className="ms-auto flex gap-2">
              {detail.status !== 'ACTIVE' && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await session.api(`${base}/restaurants/${detail.id}`, {
                        method: 'PATCH',
                        body: { version: detail.version, status: 'ACTIVE' },
                      });
                      await refresh();
                    }, t('activated'))
                  }
                >
                  {t('activate')}
                </Button>
              )}
              {detail.status === 'ACTIVE' && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await session.api(`${base}/restaurants/${detail.id}`, {
                        method: 'PATCH',
                        body: { version: detail.version, status: 'INACTIVE' },
                      });
                      await refresh();
                    })
                  }
                >
                  {t('deactivate')}
                </Button>
              )}
            </span>
          </div>

          <form
            className={cx(card, 'grid gap-3 sm:grid-cols-2')}
            aria-labelledby="rules-title"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await session.api(`${base}/restaurants/${detail.id}`, {
                  method: 'PATCH',
                  body: { version: detail.version, ...rules },
                });
                await refresh();
              }, t('saved'));
            }}
          >
            <h3 id="rules-title" className="text-sm font-bold sm:col-span-2">
              {t('rules')}
            </h3>
            {(
              [
                ['minParty', 1, 50],
                ['maxParty', 1, 50],
                ['bookDaysAhead', 0, 60],
                ['guestCutoffMinutes', 0, 1440],
              ] as const
            ).map(([key, min, max]) => (
              <label key={key} className={label}>
                {t(`rule.${key}`)}
                <input
                  type="number"
                  className={field}
                  min={min}
                  max={max}
                  value={rules[key]}
                  onChange={(e) => setRules({ ...rules, [key]: Number(e.target.value) })}
                />
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={rules.allowanceApplies}
                onChange={(e) => setRules({ ...rules, allowanceApplies: e.target.checked })}
              />
              {t('rule.allowanceApplies')}
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy}>
                {t('save')}
              </Button>
            </div>
          </form>

          <div className={cx(card, 'flex flex-col gap-3')} aria-labelledby="names-title">
            <h3 id="names-title" className="text-sm font-bold">
              {t('names')}
            </h3>
            {LOCALES.map((l) => {
              const v = names[l] ?? { name: '', description: '', dressCode: '' };
              const set = (patch: Partial<typeof v>) =>
                setNames({ ...names, [l]: { ...v, ...patch } });
              return (
                <fieldset
                  key={l}
                  className="grid gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
                  data-locale={l}
                >
                  <legend className="sr-only">{LOCALE_NAMES[l]}</legend>
                  <span className="self-center text-sm font-semibold" aria-hidden>
                    {LOCALE_NAMES[l]}
                  </span>
                  <input
                    aria-label={t('name_in', { language: LOCALE_NAMES[l] })}
                    placeholder={t('name')}
                    className={field}
                    dir={l === 'ar' ? 'rtl' : 'ltr'}
                    maxLength={120}
                    value={v.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                  <input
                    aria-label={t('description_in', { language: LOCALE_NAMES[l] })}
                    placeholder={t('description')}
                    className={field}
                    dir={l === 'ar' ? 'rtl' : 'ltr'}
                    maxLength={1000}
                    value={v.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                  <Button
                    variant="secondary"
                    disabled={busy || !v.name.trim()}
                    onClick={() =>
                      void run(async () => {
                        await session.api(`${base}/restaurants/${detail.id}/translations/${l}`, {
                          method: 'PUT',
                          body: {
                            name: v.name.trim(),
                            description: v.description.trim() || null,
                            dressCode: v.dressCode.trim() || null,
                          },
                        });
                        await refresh();
                      }, t('saved'))
                    }
                  >
                    {t('save')}
                  </Button>
                  <input
                    aria-label={t('dress_code_in', { language: LOCALE_NAMES[l] })}
                    placeholder={t('dress_code')}
                    className={cx(field, 'sm:col-start-2 sm:col-span-2')}
                    dir={l === 'ar' ? 'rtl' : 'ltr'}
                    maxLength={300}
                    value={v.dressCode}
                    onChange={(e) => set({ dressCode: e.target.value })}
                  />
                </fieldset>
              );
            })}
          </div>

          <div className={cx(card, 'flex flex-col gap-3')} aria-labelledby="week-title">
            <h3 id="week-title" className="text-sm font-bold">
              {t('schedule')}
            </h3>
            <p className="text-xs text-slate-600">{t('schedule_hint')}</p>
            <ul className="flex flex-col gap-2">
              {rows.map((r, i) => (
                <li key={i} className="flex flex-wrap items-end gap-2" data-row={i}>
                  <label className={label}>
                    {t('weekday')}
                    <select
                      className={field}
                      value={r.weekday}
                      onChange={(e) =>
                        setRows(
                          rows.map((x, j) =>
                            j === i ? { ...x, weekday: Number(e.target.value) } : x,
                          ),
                        )
                      }
                    >
                      {WEEK.map((d) => (
                        <option key={d} value={d}>
                          {clock.weekday(d)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={label}>
                    {t('time')}
                    <input
                      type="time"
                      className={field}
                      value={r.startsAt}
                      onChange={(e) =>
                        setRows(
                          rows.map((x, j) => (j === i ? { ...x, startsAt: e.target.value } : x)),
                        )
                      }
                    />
                  </label>
                  <label className={label}>
                    {t('seats_label')}
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      className={cx(field, 'w-24')}
                      value={r.seats}
                      onChange={(e) =>
                        setRows(
                          rows.map((x, j) =>
                            j === i ? { ...x, seats: Number(e.target.value) } : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    {t('remove')}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setRows([...rows, { weekday: 1, startsAt: '19:00', seats: 20 }])}
              >
                {t('add_sitting')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  // Copies the first row to every day of the week that has none at that time.
                  const first = rows[0];
                  if (!first) return;
                  const more = WEEK.filter(
                    (d) => !rows.some((x) => x.weekday === d && x.startsAt === first.startsAt),
                  ).map((d) => ({ ...first, weekday: d }));
                  setRows([...rows, ...more]);
                }}
              >
                {t('every_day')}
              </Button>
              <label className={cx(label, 'ms-auto')}>
                {t('applies_from')}
                <input
                  type="date"
                  className={field}
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || !fromDate}
                onClick={() =>
                  void run(async () => {
                    await session.api(`${base}/restaurants/${detail.id}/sittings`, {
                      method: 'PUT',
                      body: { fromDate, sittings: rows },
                    });
                    await refresh();
                  }, t('saved'))
                }
              >
                {t('save_schedule')}
              </Button>
            </div>
          </div>

          <div className={cx(card, 'flex flex-col gap-3')} aria-labelledby="closures-title">
            <h3 id="closures-title" className="text-sm font-bold">
              {t('closures')}
            </h3>
            {detail.closures.length === 0 && (
              <p className="text-sm text-slate-500">{t('no_closures')}</p>
            )}
            <ul className="flex flex-col gap-1.5">
              {detail.closures.map((c) => {
                const s = detail.sittings.find((x) => x.id === c.sittingId);
                return (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                    data-closure={c.onDate}
                  >
                    <span className="font-semibold">{clock.day(c.onDate)}</span>
                    <span className="text-slate-600">
                      {s ? clock.time(s.startsAt) : t('whole_day')}
                    </span>
                    <span className="text-slate-600">{c.reason}</span>
                    <Button
                      variant="ghost"
                      className="ms-auto"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await session.api(`${base}/restaurants/${detail.id}/closures/${c.id}`, {
                            method: 'DELETE',
                          });
                          await refresh();
                        }, t('reopened'))
                      }
                    >
                      {t('reopen')}
                    </Button>
                  </li>
                );
              })}
            </ul>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await session.api(`${base}/restaurants/${detail.id}/closures`, {
                    method: 'POST',
                    body: {
                      onDate: closure.onDate,
                      sittingId: closure.sittingId || null,
                      reason: closure.reason.trim(),
                    },
                  });
                  setClosure({ onDate: '', sittingId: '', reason: '' });
                  await refresh();
                }, t('closed'));
              }}
            >
              <label className={label}>
                {t('date')}
                <input
                  type="date"
                  required
                  className={field}
                  min={localToday()}
                  value={closure.onDate}
                  onChange={(e) =>
                    setClosure({ ...closure, onDate: e.target.value, sittingId: '' })
                  }
                />
              </label>
              <label className={label}>
                {t('sitting')}
                <select
                  className={field}
                  value={closure.sittingId}
                  onChange={(e) => setClosure({ ...closure, sittingId: e.target.value })}
                >
                  <option value="">{t('whole_day')}</option>
                  {detail.sittings
                    .filter(
                      (s) =>
                        closure.onDate &&
                        s.weekday === new Date(`${closure.onDate}T12:00:00Z`).getUTCDay(),
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {clock.time(s.startsAt)}
                      </option>
                    ))}
                </select>
              </label>
              <label className={cx(label, 'min-w-48 flex-1')}>
                {t('reason')}
                <input
                  required
                  minLength={2}
                  maxLength={500}
                  className={field}
                  value={closure.reason}
                  onChange={(e) => setClosure({ ...closure, reason: e.target.value })}
                />
              </label>
              <Button type="submit" variant="secondary" disabled={busy}>
                {t('close')}
              </Button>
            </form>
          </div>
        </section>
      )}
    </main>
  );
}
