'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx, ImageIcon } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type {
  LostFoundDetail,
  LostFoundItem,
  LostFoundMatch,
  LostFoundStatus,
  RoomRow,
} from '../lib/types';

const CATEGORIES = [
  'PHONE',
  'ELECTRONICS',
  'JEWELLERY',
  'WATCH',
  'CLOTHING',
  'BAG',
  'DOCUMENT',
  'MONEY',
  'KEYS',
  'GLASSES',
  'TOILETRIES',
  'TOY',
  'OTHER',
] as const;
const COLOURS = [
  'BLACK',
  'WHITE',
  'GREY',
  'SILVER',
  'GOLD',
  'RED',
  'PINK',
  'ORANGE',
  'YELLOW',
  'GREEN',
  'BLUE',
  'PURPLE',
  'BROWN',
  'BEIGE',
  'MULTI',
] as const;
const STATUS_TONE: Record<LostFoundStatus, 'neutral' | 'info' | 'warning' | 'success'> = {
  REGISTERED: 'warning',
  MATCHED: 'info',
  CLAIMED: 'success',
  RELEASED: 'success',
  DISPOSED: 'neutral',
};
type Tab = 'FOUND' | 'LOST' | 'DUE';
const EMPTY = {
  kind: 'FOUND' as 'FOUND' | 'LOST',
  category: '',
  colour: '',
  brand: '',
  description: '',
  locationId: '',
  placeNote: '',
  storageLocation: '',
};
const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5';
const field = 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm';
const label = 'flex flex-col gap-1 text-xs font-semibold text-slate-600';

/**
 * Lost & Found for staff (Spec §13, BUILD_PLAN 9.3): anyone on the floor hands in what they find (with a photo);
 * the desk records guests' losses, decides the matches the platform proposes (with its reasons), hands items back
 * against a claim record and disposes of unclaimed ones only once their retention date has passed. Logical
 * properties only, so it mirrors in Arabic.
 */
export function LostFoundApp() {
  const t = useTranslations('staff.lf');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } =
    usePropertiesWith('lostfound.register');
  const { show: showBrand } = useStaffBrand();
  const [tab, setTab] = useState<Tab>('FOUND');
  const [items, setItems] = useState<LostFoundItem[]>([]);
  const [matches, setMatches] = useState<LostFoundMatch[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [open, setOpen] = useState<LostFoundDetail | null>(null);
  const [release, setRelease] = useState({
    claimantName: '',
    idDocument: 'PASSPORT',
    verificationNote: '',
  });
  const [disposal, setDisposal] = useState({ method: 'DONATED', note: '' });
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
      read: held.has('lostfound.read'),
      manage: held.has('lostfound.manage'),
      release: held.has('lostfound.release'),
    };
  }, [me, propertyId]);

  const base = propertyId ? `/properties/${propertyId}` : null;
  const load = useCallback(async () => {
    if (!base) return;
    setRooms(await session.api<RoomRow[]>(`${base}/rooms`));
    if (!can.read) return;
    const query = tab === 'DUE' ? '?due=true' : `?kind=${tab}&status=REGISTERED,MATCHED`;
    const [list, proposed] = await Promise.all([
      session.api<LostFoundItem[]>(`${base}/lostfound/items${query}`),
      session.api<LostFoundMatch[]>(`${base}/lostfound/matches`),
    ]);
    setItems(list);
    setMatches(proposed);
  }, [session, base, can.read, tab]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  const openItem = useCallback(
    async (id: string) => {
      if (!base) return;
      setOpen(await session.api<LostFoundDetail>(`${base}/lostfound/items/${id}`));
    },
    [session, base],
  );

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const day = (date: string) =>
    format.dateTime(new Date(`${date}T00:00:00Z`), { dateStyle: 'medium' });
  const title = (i: LostFoundItem) =>
    t('item_title', {
      number: i.number,
      category: t(`category.${i.category}`),
    });
  const where = (i: LostFoundItem) =>
    i.roomNumber ? t('room_n', { room: i.roomNumber }) : (i.placeNote ?? '');

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
              setOpen(null);
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
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      ) : (
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <section className="flex flex-col gap-3" aria-labelledby="list-title">
            <form
              aria-label={form.kind === 'FOUND' ? t('hand_in') : t('record_loss')}
              className={cx(card, 'flex flex-col gap-2')}
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  async () => {
                    const body = Object.fromEntries(
                      Object.entries(form).filter(([, v]) => v !== ''),
                    );
                    const created = await session.api<{ id: string }>(`${base}/lostfound/items`, {
                      method: 'POST',
                      body,
                    });
                    setForm({ ...EMPTY, kind: form.kind });
                    await load();
                    if (can.read) await openItem(created.id);
                  },
                  form.kind === 'FOUND' ? t('handed_in') : t('loss_recorded'),
                );
              }}
            >
              {can.manage ? (
                <div className="flex gap-2" role="group" aria-label={t('kind_label')}>
                  {(['FOUND', 'LOST'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={form.kind === k}
                      onClick={() => setForm({ ...form, kind: k })}
                      className={cx(
                        'rounded-full px-3 py-1 text-sm font-semibold ring-1',
                        form.kind === k
                          ? 'bg-brand text-white ring-transparent'
                          : 'bg-white text-slate-700 ring-slate-300',
                      )}
                    >
                      {k === 'FOUND' ? t('hand_in') : t('record_loss')}
                    </button>
                  ))}
                </div>
              ) : (
                <h2 className="font-bold">{t('hand_in')}</h2>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label className={label}>
                  {t('category_label')}
                  <select
                    className={field}
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    <option value="">{t('choose')}</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {t(`category.${c}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={label}>
                  {t('colour_label')}
                  <select
                    className={field}
                    value={form.colour}
                    onChange={(e) => setForm({ ...form, colour: e.target.value })}
                  >
                    <option value="">{t('unknown')}</option>
                    {COLOURS.map((c) => (
                      <option key={c} value={c}>
                        {t(`colour.${c}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={label}>
                  {t('brand')}
                  <input
                    className={field}
                    value={form.brand}
                    onChange={(e) => setForm({ ...form, brand: e.target.value })}
                  />
                </label>
                <label className={label}>
                  {t('room')}
                  <select
                    className={field}
                    value={form.locationId}
                    onChange={(e) => setForm({ ...form, locationId: e.target.value })}
                  >
                    <option value="">{t('no_room')}</option>
                    {rooms.map((r) => (
                      <option key={r.locationId} value={r.locationId}>
                        {r.roomNumber}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!form.locationId && (
                <label className={label}>
                  {t('place')}
                  <input
                    className={field}
                    value={form.placeNote}
                    onChange={(e) => setForm({ ...form, placeNote: e.target.value })}
                  />
                </label>
              )}
              <label className={label}>
                {t('description')}
                <textarea
                  className={field}
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>
              {form.kind === 'FOUND' && (
                <label className={label}>
                  {t('storage')}
                  <input
                    className={field}
                    value={form.storageLocation}
                    onChange={(e) => setForm({ ...form, storageLocation: e.target.value })}
                  />
                </label>
              )}
              <div>
                <Button
                  type="submit"
                  disabled={busy || !form.category || form.description.trim().length < 3}
                >
                  {form.kind === 'FOUND' ? t('hand_in') : t('record_loss')}
                </Button>
              </div>
            </form>

            {can.read && matches.length > 0 && (
              <div className={cx(card, 'flex flex-col gap-3')} aria-labelledby="matches-title">
                <h2 id="matches-title" className="font-bold">
                  {t('matches', { count: matches.length })}
                </h2>
                <ul className="flex flex-col gap-3">
                  {matches.map((m) => (
                    <li
                      key={m.id}
                      data-match={m.id}
                      className="flex flex-col gap-2 rounded-xl bg-slate-50 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold">{title(m.found)}</span>
                        <span aria-hidden>↔</span>
                        <span className="font-semibold">{title(m.lost)}</span>
                        <span className="ms-auto text-xs font-bold text-slate-600">
                          {t('score', { score: m.score })}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {m.reasons.map((r) => (
                          <Badge key={r} tone="info">
                            {t(`reason.${r}`)}
                          </Badge>
                        ))}
                      </div>
                      {can.manage && (
                        <div className="flex gap-2">
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await session.api(`${base}/lostfound/matches/${m.id}/confirm`, {
                                  method: 'POST',
                                  body: { version: m.version },
                                });
                                await load();
                                await openItem(m.found.id);
                              }, t('match_confirmed'))
                            }
                          >
                            {t('confirm_match')}
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await session.api(`${base}/lostfound/matches/${m.id}/reject`, {
                                  method: 'POST',
                                  body: { version: m.version },
                                });
                                await load();
                              })
                            }
                          >
                            {t('not_a_match')}
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {can.read && (
              <>
                <div className="flex gap-1" role="tablist" aria-label={t('lists')}>
                  {(['FOUND', 'LOST', 'DUE'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      onClick={() => setTab(k)}
                      className={cx(
                        'rounded-full px-3 py-1 text-sm font-semibold',
                        tab === k ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100',
                      )}
                    >
                      {t(`tab.${k}`)}
                    </button>
                  ))}
                </div>
                <h2 id="list-title" className="sr-only">
                  {t(`tab.${tab}`)}
                </h2>
                {items.length === 0 && (
                  <p className={cx(card, 'text-sm text-slate-500')}>{t('none')}</p>
                )}
                <ul className="flex flex-col gap-2">
                  {items.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        data-item={i.number}
                        aria-pressed={open?.id === i.id}
                        onClick={() => void openItem(i.id).catch(fail)}
                        className={cx(
                          card,
                          'flex w-full flex-wrap items-center gap-2 text-start',
                          open?.id === i.id && 'ring-2 ring-[var(--brand-primary,#0f4c81)]',
                        )}
                      >
                        <span className="font-bold">{title(i)}</span>
                        {i.colour && (
                          <span className="text-sm text-slate-600">{t(`colour.${i.colour}`)}</span>
                        )}
                        {i.valuable && <Badge tone="warning">{t('valuable')}</Badge>}
                        <span className="ms-auto">
                          <Badge tone={i.retentionDue ? 'danger' : STATUS_TONE[i.status]}>
                            {i.retentionDue ? t('due') : t(`status.${i.status}`)}
                          </Badge>
                        </span>
                        <span className="w-full truncate text-sm text-slate-700">
                          {i.description}
                        </span>
                        <span className="w-full text-xs text-slate-500">
                          {[where(i), when(i.occurredAt)].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="flex flex-col gap-3 self-start" aria-labelledby="detail-title">
            {!open ? (
              can.read && (
                <p id="detail-title" className={cx(card, 'text-sm text-slate-500')}>
                  {t('pick')}
                </p>
              )
            ) : (
              <>
                <div className={cx(card, 'flex flex-col gap-2')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="detail-title" className="text-lg font-bold">
                      {title(open)}
                    </h2>
                    <Badge tone="neutral">{t(`kind.${open.kind}`)}</Badge>
                    <span className="ms-auto" data-testid="status">
                      <Badge tone={STATUS_TONE[open.status]}>{t(`status.${open.status}`)}</Badge>
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{open.description}</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {open.colour && (
                      <>
                        <dt className="text-slate-500">{t('colour_label')}</dt>
                        <dd>{t(`colour.${open.colour}`)}</dd>
                      </>
                    )}
                    {open.brand && (
                      <>
                        <dt className="text-slate-500">{t('brand')}</dt>
                        <dd>{open.brand}</dd>
                      </>
                    )}
                    {where(open) && (
                      <>
                        <dt className="text-slate-500">{t('where')}</dt>
                        <dd>{where(open)}</dd>
                      </>
                    )}
                    {open.storageLocation && (
                      <>
                        <dt className="text-slate-500">{t('storage')}</dt>
                        <dd>{open.storageLocation}</dd>
                      </>
                    )}
                    {open.retentionUntil && (
                      <>
                        <dt className="text-slate-500">{t('keep_until')}</dt>
                        <dd>{day(open.retentionUntil)}</dd>
                      </>
                    )}
                  </dl>
                  {open.ai && (
                    <p className="text-xs text-slate-500" data-testid="ai">
                      {t('ai_read', {
                        what: [
                          open.ai.objectType,
                          ...open.ai.colours.map((c) => t(`colour.${c}`)),
                          open.ai.brand,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      })}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {open.photoKeys.map((k) => (
                      <img
                        key={k}
                        src={`/hotella${base}/lostfound/items/${open.id}/photos/${k}`}
                        alt=""
                        className="size-16 rounded-lg object-cover ring-1 ring-slate-900/10"
                      />
                    ))}
                    {(open.status === 'REGISTERED' || open.status === 'MATCHED') && (
                      <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 ring-slate-300 hover:bg-slate-50">
                        <ImageIcon className="size-4" />
                        {t('add_photo')}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          capture="environment"
                          className="sr-only"
                          data-testid="photo"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file)
                              void run(async () => {
                                await session.api(`${base}/lostfound/items/${open.id}/photos`, {
                                  method: 'POST',
                                  file,
                                });
                                await openItem(open.id);
                              });
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {open.matches.length > 0 && (
                  <div className={cx(card, 'flex flex-col gap-1')}>
                    <h3 className="font-bold">{t('linked')}</h3>
                    <ul className="flex flex-col gap-1 text-sm">
                      {open.matches.map((m) => (
                        <li key={m.id} className="flex flex-wrap gap-2" data-linked={m.status}>
                          <span>{title(m.other)}</span>
                          <span className="text-slate-500">{t(`match_status.${m.status}`)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {open.claim && (
                  <div className={cx(card, 'text-sm')} data-testid="claim">
                    {t('released_to', {
                      name: open.claim.claimantName,
                      when: when(open.claim.releasedAt),
                    })}
                  </div>
                )}

                {can.release &&
                  open.kind === 'FOUND' &&
                  (open.status === 'REGISTERED' || open.status === 'MATCHED') && (
                    <form
                      aria-label={t('release')}
                      className={cx(card, 'flex flex-col gap-2')}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await session.api(`${base}/lostfound/items/${open.id}/release`, {
                            method: 'POST',
                            body: { ...release, version: open.version },
                          });
                          setRelease({
                            claimantName: '',
                            idDocument: 'PASSPORT',
                            verificationNote: '',
                          });
                          await Promise.all([load(), openItem(open.id)]);
                        }, t('released'));
                      }}
                    >
                      <h3 className="font-bold">{t('release')}</h3>
                      <div className="grid grid-cols-2 gap-2">
                        <label className={label}>
                          {t('claimant')}
                          <input
                            className={field}
                            value={release.claimantName}
                            onChange={(e) =>
                              setRelease({ ...release, claimantName: e.target.value })
                            }
                          />
                        </label>
                        <label className={label}>
                          {t('id_document')}
                          <select
                            className={field}
                            value={release.idDocument}
                            onChange={(e) => setRelease({ ...release, idDocument: e.target.value })}
                          >
                            {[
                              'PASSPORT',
                              'NATIONAL_ID',
                              'DRIVING_LICENCE',
                              'ROOM_KEY_AND_PMS',
                              'OTHER',
                            ].map((d) => (
                              <option key={d} value={d}>
                                {t(`document.${d}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label className={label}>
                        {t('verification')}
                        <textarea
                          className={field}
                          rows={2}
                          value={release.verificationNote}
                          onChange={(e) =>
                            setRelease({ ...release, verificationNote: e.target.value })
                          }
                        />
                      </label>
                      <p className="text-xs text-slate-500">{t('release_hint')}</p>
                      <div>
                        <Button
                          type="submit"
                          disabled={
                            busy ||
                            release.claimantName.trim().length < 2 ||
                            release.verificationNote.trim().length < 3
                          }
                        >
                          {t('release')}
                        </Button>
                      </div>
                    </form>
                  )}

                {can.manage && open.retentionDue && (
                  <form
                    aria-label={t('dispose')}
                    className={cx(card, 'flex flex-col gap-2')}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        await session.api(`${base}/lostfound/items/${open.id}/dispose`, {
                          method: 'POST',
                          body: { ...disposal, version: open.version },
                        });
                        setDisposal({ method: 'DONATED', note: '' });
                        await Promise.all([load(), openItem(open.id)]);
                      }, t('disposed'));
                    }}
                  >
                    <h3 className="font-bold">{t('dispose')}</h3>
                    <label className={label}>
                      {t('method')}
                      <select
                        className={field}
                        value={disposal.method}
                        onChange={(e) => setDisposal({ ...disposal, method: e.target.value })}
                      >
                        {['DONATED', 'DESTROYED', 'HANDED_TO_AUTHORITIES', 'GIVEN_TO_FINDER'].map(
                          (m) => (
                            <option key={m} value={m}>
                              {t(`method_option.${m}`)}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className={label}>
                      {t('dispose_reason')}
                      <input
                        className={field}
                        value={disposal.note}
                        onChange={(e) => setDisposal({ ...disposal, note: e.target.value })}
                      />
                    </label>
                    <div>
                      <Button
                        type="submit"
                        variant="danger"
                        disabled={busy || disposal.note.trim().length < 3}
                      >
                        {t('dispose')}
                      </Button>
                    </div>
                  </form>
                )}

                <div className={cx(card, 'flex flex-col gap-1')}>
                  <h3 className="font-bold">{t('history')}</h3>
                  <ol className="flex flex-col gap-1 text-sm">
                    {open.history.map((e) => (
                      <li key={e.id} className="flex flex-wrap gap-2">
                        <span className="text-slate-500">{when(e.createdAt)}</span>
                        <span>{t(`event.${e.event}`)}</span>
                        {e.note && <span className="text-slate-500">— {e.note}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            )}
          </section>
        </main>
      )}
    </>
  );
}
