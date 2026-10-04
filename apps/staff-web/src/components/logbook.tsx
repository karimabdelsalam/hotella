'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { DepartmentRow, Handover, RoomRow, ShiftView } from '../lib/types';

const KINDS = ['NOTE', 'INCIDENT', 'HANDOVER_ITEM'] as const;
const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5';
const field = 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm';
const label = 'flex flex-col gap-1 text-xs font-semibold text-slate-600';

/**
 * The shift logbook for staff (Spec §14, BUILD_PLAN 9.4): what happened on the running shift of a department, the
 * facts the platform counts (open work, complaints, rooms out of order, lost & found), and the handover — drafted
 * by the assistant from those facts, edited, and acknowledged by the person taking the shift over. Logical
 * properties only, so it mirrors in Arabic.
 */
export function LogbookApp() {
  const t = useTranslations('staff.log');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } = usePropertiesWith('logbook.read');
  const { show: showBrand } = useStaffBrand();
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [department, setDepartment] = useState('');
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [view, setView] = useState<ShiftView | null>(null);
  const [entry, setEntry] = useState({
    kind: 'NOTE' as (typeof KINDS)[number],
    text: '',
    roomId: '',
  });
  const [summary, setSummary] = useState('');
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
      write: held.has('logbook.write'),
      acknowledge: held.has('logbook.handover.acknowledge'),
    };
  }, [me, propertyId]);

  const base = propertyId ? `/properties/${propertyId}` : null;
  useEffect(() => {
    if (!base) return;
    Promise.all([
      session.api<DepartmentRow[]>(`${base}/departments`),
      session.api<RoomRow[]>(`${base}/rooms`),
    ])
      .then(([d, r]) => {
        const active = d.filter((x) => x.status === 'ACTIVE');
        setDepartments(active);
        setRooms(r);
        setDepartment((current) => current || active[0]?.code || '');
      })
      .catch(fail);
  }, [session, base, fail]);

  const load = useCallback(async () => {
    if (!base || !department) return;
    const shift = await session.api<ShiftView>(
      `${base}/logbook/shift?departmentCode=${department}`,
    );
    setView(shift);
    setSummary(shift.handover?.summary ?? '');
  }, [session, base, department]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

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

  const time = (iso: string) => format.dateTime(new Date(iso), { timeStyle: 'short' });
  const handover: Handover | null = view?.handover ?? null;
  const drafter = handover?.draftedById && handover.draftedById === me?.user.id;

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
              setDepartment('');
              setView(null);
            }}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label={t('department')}
          className="rounded-full border border-slate-300 bg-white px-3 py-1"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
        >
          {departments.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name}
            </option>
          ))}
        </select>
        {view && (
          <span className="ms-auto text-slate-600" data-testid="shift">
            {t('shift_title', {
              shift: t(`shift.${view.shift}`),
              date: format.dateTime(new Date(`${view.shiftDate}T12:00:00Z`), {
                dateStyle: 'medium',
              }),
              from: time(view.window.from),
              to: time(view.window.to),
            })}
          </span>
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
        view && (
          <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <section className="flex flex-col gap-3" aria-labelledby="entries-title">
              <dl className={cx(card, 'grid grid-cols-2 gap-3 sm:grid-cols-4')} data-testid="facts">
                {[
                  ['open_work', view.facts.work.open],
                  ['urgent', view.facts.work.urgent],
                  ['overdue', view.facts.work.overdue],
                  ['incidents', view.facts.entries.incidents],
                  ...(view.facts.complaints
                    ? ([['complaints', view.facts.complaints.open]] as const)
                    : []),
                  ...(view.facts.rooms_out_of_order
                    ? ([['out_of_order', view.facts.rooms_out_of_order.length]] as const)
                    : []),
                  ...(view.facts.lost_found
                    ? ([['lost_found', view.facts.lost_found.found_waiting]] as const)
                    : []),
                ].map(([key, n]) => (
                  <div key={key} className="flex flex-col" data-fact={key}>
                    <dt className="text-xs text-slate-500">{t(`fact.${key}`)}</dt>
                    <dd className="text-xl font-bold tabular-nums">{n}</dd>
                  </div>
                ))}
              </dl>

              {can.write && (
                <form
                  aria-label={t('add_entry')}
                  className={cx(card, 'flex flex-col gap-2')}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await session.api(`${base}/logbook/entries`, {
                        method: 'POST',
                        body: {
                          departmentCode: department,
                          kind: entry.kind,
                          text: entry.text,
                          ...(entry.roomId ? { roomId: entry.roomId } : {}),
                        },
                      });
                      setEntry({ kind: 'NOTE', text: '', roomId: '' });
                      await load();
                    }, t('entry_added'));
                  }}
                >
                  <div className="flex flex-wrap gap-2" role="group" aria-label={t('kind_label')}>
                    {KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={entry.kind === k}
                        onClick={() => setEntry({ ...entry, kind: k })}
                        className={cx(
                          'rounded-full px-3 py-1 text-sm font-semibold ring-1',
                          entry.kind === k
                            ? k === 'INCIDENT'
                              ? 'bg-red-700 text-white ring-transparent'
                              : 'bg-brand text-white ring-transparent'
                            : 'bg-white text-slate-700 ring-slate-300',
                        )}
                      >
                        {t(`kind.${k}`)}
                      </button>
                    ))}
                  </div>
                  <label className={label}>
                    {t('what_happened')}
                    <textarea
                      className={field}
                      rows={2}
                      value={entry.text}
                      onChange={(e) => setEntry({ ...entry, text: e.target.value })}
                    />
                  </label>
                  <label className={label}>
                    {t('room')}
                    <select
                      className={field}
                      value={entry.roomId}
                      onChange={(e) => setEntry({ ...entry, roomId: e.target.value })}
                    >
                      <option value="">{t('no_room')}</option>
                      {rooms.map((r) => (
                        <option key={r.locationId} value={r.locationId}>
                          {r.roomNumber}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div>
                    <Button type="submit" disabled={busy || entry.text.trim().length < 2}>
                      {t('add_entry')}
                    </Button>
                  </div>
                </form>
              )}

              <h2 id="entries-title" className="px-1 text-sm font-bold text-slate-500">
                {t('entries')}
              </h2>
              {view.entries.length === 0 && (
                <p className={cx(card, 'text-sm text-slate-500')}>{t('no_entries')}</p>
              )}
              <ol className="flex flex-col gap-2">
                {view.entries.map((e) => (
                  <li key={e.id} className={cx(card, 'flex flex-col gap-1')} data-entry={e.kind}>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <Badge
                        tone={
                          e.kind === 'INCIDENT' ? 'danger' : e.kind === 'NOTE' ? 'neutral' : 'info'
                        }
                      >
                        {t(`kind.${e.kind}`)}
                      </Badge>
                      <span>{time(e.createdAt)}</span>
                      {e.roomNumber && <span>{t('room_n', { room: e.roomNumber })}</span>}
                      {e.correctsEntryId && <span>{t('correction')}</span>}
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{e.text}</p>
                  </li>
                ))}
              </ol>
            </section>

            <section
              className={cx(card, 'flex flex-col gap-3 self-start')}
              aria-labelledby="handover-title"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="handover-title" className="text-lg font-bold">
                  {t('handover')}
                </h2>
                {handover && (
                  <span className="ms-auto flex gap-1" data-testid="handover-status">
                    {handover.source === 'AI' && (
                      <Badge tone="info">{handover.edited ? t('ai_edited') : t('ai_draft')}</Badge>
                    )}
                    <Badge tone={handover.status === 'ACKNOWLEDGED' ? 'success' : 'warning'}>
                      {t(`handover_status.${handover.status}`)}
                    </Badge>
                  </span>
                )}
              </div>
              {!handover && <p className="text-sm text-slate-500">{t('no_handover')}</p>}
              {!handover && can.write && (
                <div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await session.api(`${base}/logbook/handovers`, {
                          method: 'POST',
                          body: { departmentCode: department },
                        });
                        await load();
                      }, t('drafted'))
                    }
                  >
                    {t('draft')}
                  </Button>
                </div>
              )}
              {handover?.status === 'DRAFT' && (
                <>
                  <p className="text-xs text-slate-500">{t('draft_hint')}</p>
                  <label className={label}>
                    {t('summary')}
                    <textarea
                      className={cx(field, 'min-h-48')}
                      value={summary}
                      readOnly={!can.write}
                      onChange={(e) => setSummary(e.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {can.write && (
                      <Button
                        variant="secondary"
                        disabled={busy || !summary.trim() || summary === handover.summary}
                        onClick={() =>
                          void run(async () => {
                            await session.api(`${base}/logbook/handovers/${handover.id}`, {
                              method: 'PUT',
                              body: { version: handover.version, summary },
                            });
                            await load();
                          }, t('saved'))
                        }
                      >
                        {t('save')}
                      </Button>
                    )}
                    {can.acknowledge && !drafter && (
                      <Button
                        disabled={busy || !handover.summary.trim() || summary !== handover.summary}
                        onClick={() =>
                          void run(async () => {
                            await session.api(
                              `${base}/logbook/handovers/${handover.id}/acknowledge`,
                              { method: 'POST', body: { version: handover.version } },
                            );
                            await load();
                          }, t('acknowledged'))
                        }
                      >
                        {t('acknowledge')}
                      </Button>
                    )}
                  </div>
                  {drafter && <p className="text-xs text-slate-500">{t('not_yours')}</p>}
                </>
              )}
              {handover?.status === 'ACKNOWLEDGED' && (
                <>
                  <p className="text-sm whitespace-pre-wrap" data-testid="summary">
                    {handover.summary}
                  </p>
                  {handover.acknowledgedAt && (
                    <p className="text-xs text-slate-500">
                      {t('acknowledged_at', {
                        when: format.dateTime(new Date(handover.acknowledgedAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })}
                    </p>
                  )}
                </>
              )}
            </section>
          </main>
        )
      )}
    </>
  );
}
