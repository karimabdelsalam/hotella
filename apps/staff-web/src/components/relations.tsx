'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type {
  ComplaintCandidate,
  ComplaintCategory,
  ComplaintDetail,
  ComplaintSeverity,
  ComplaintStatus,
  ComplaintSummary,
  RecoveryKind,
  RoomRow,
} from '../lib/types';

const SEVERITY_TONE: Record<ComplaintSeverity, 'neutral' | 'info' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  CRITICAL: 'danger',
};
const STATUS_TONE: Record<ComplaintStatus, 'neutral' | 'info' | 'warning' | 'success'> = {
  OPEN: 'warning',
  IN_PROGRESS: 'info',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};
/** The moves the platform allows (the server decides; this only offers the buttons). */
const NEXT: Record<ComplaintStatus, readonly ComplaintStatus[]> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};
const RECOVERY_KINDS: readonly RecoveryKind[] = [
  'APOLOGY',
  'AMENITY',
  'MEAL',
  'DISCOUNT',
  'REFUND',
  'ROOM_MOVE',
  'OTHER',
];
const WITH_AMOUNT = new Set<RecoveryKind>(['MEAL', 'DISCOUNT', 'REFUND']);
const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5';
const field = 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm';
const label = 'flex flex-col gap-1 text-xs font-semibold text-slate-600';

/**
 * Guest relations for staff (Spec §12, BUILD_PLAN 9.2): the concierge's suggestions to confirm or dismiss, complaints
 * with their evidence and history, status changes, notes and service recovery (anything that costs money waits for a
 * manager's approval). Logical properties only, so it mirrors in Arabic.
 */
export function RelationsApp() {
  const t = useTranslations('staff.rel');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } = usePropertiesWith('complaint.read');
  const { show: showBrand } = useStaffBrand();
  const [complaints, setComplaints] = useState<ComplaintSummary[]>([]);
  const [candidates, setCandidates] = useState<ComplaintCandidate[]>([]);
  const [categories, setCategories] = useState<ComplaintCategory[]>([]);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [open, setOpen] = useState<ComplaintDetail | null>(null);
  const [form, setForm] = useState({ categoryId: '', roomId: '', summary: '' });
  const [note, setNote] = useState('');
  const [recovery, setRecovery] = useState<{ kind: RecoveryKind; amount: string; note: string }>({
    kind: 'APOLOGY',
    amount: '',
    note: '',
  });
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
    return { manage: held.has('complaint.manage'), recover: held.has('complaint.recovery.manage') };
  }, [me, propertyId]);

  const base = propertyId ? `/properties/${propertyId}` : null;
  const load = useCallback(async () => {
    if (!base) return;
    const status = showClosed ? '' : '?status=OPEN,IN_PROGRESS,RESOLVED';
    const [list, pending, cats, roomRows] = await Promise.all([
      session.api<ComplaintSummary[]>(`${base}/complaints${status}`),
      session.api<ComplaintCandidate[]>(`${base}/complaint-candidates`),
      session.api<ComplaintCategory[]>('/relations/categories'),
      session.api<RoomRow[]>(`${base}/rooms`),
    ]);
    setComplaints(list);
    setCandidates(pending);
    setCategories(cats.filter((c) => c.active));
    setRooms(roomRows);
  }, [session, base, showClosed]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  const openComplaint = useCallback(
    async (id: string) => {
      if (!base) return;
      setOpen(await session.api<ComplaintDetail>(`${base}/complaints/${id}`));
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

  const money = (minor: number, currency: string | null) =>
    currency
      ? format.number(minor / 100, { style: 'currency', currency })
      : format.number(minor / 100);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

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
        <label className="ms-auto flex items-center gap-2 text-slate-600">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          {t('show_closed')}
        </label>
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
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <section className="flex flex-col gap-3" aria-labelledby="list-title">
            {candidates.length > 0 && (
              <div className={cx(card, 'flex flex-col gap-3')} aria-labelledby="ai-title">
                <h2 id="ai-title" className="font-bold">
                  {t('suggestions', { count: candidates.length })}
                </h2>
                <p className="text-xs text-slate-500">{t('suggestions_hint')}</p>
                <ul className="flex flex-col gap-3">
                  {candidates.map((c) => (
                    <li
                      key={c.id}
                      data-candidate={c.id}
                      className="flex flex-col gap-2 rounded-xl bg-slate-50 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{c.categoryName}</span>
                        <Badge tone={SEVERITY_TONE[c.severity]}>
                          {t(`severity.${c.severity}`)}
                        </Badge>
                        <span className="ms-auto text-xs text-slate-500">
                          {t('confidence', { value: Math.round(c.confidence * 100) })}
                        </span>
                      </div>
                      <p className="text-sm">{c.summary}</p>
                      {c.guestWords && (
                        <blockquote className="border-s-4 border-slate-300 ps-3 text-sm text-slate-700 italic">
                          {c.guestWords}
                        </blockquote>
                      )}
                      <p className="text-xs text-slate-500">
                        {t('ai_reason')}: {c.reason}
                      </p>
                      {can.manage && (
                        <div className="flex gap-2">
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const done = await session.api<{ complaint: { id: string } }>(
                                  `${base}/complaint-candidates/${c.id}/confirm`,
                                  { method: 'POST', body: { version: c.version } },
                                );
                                await load();
                                await openComplaint(done.complaint.id);
                              }, t('confirmed'))
                            }
                          >
                            {t('confirm')}
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await session.api(`${base}/complaint-candidates/${c.id}/dismiss`, {
                                  method: 'POST',
                                  body: { version: c.version },
                                });
                                await load();
                              }, t('dismissed'))
                            }
                          >
                            {t('dismiss')}
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {can.manage && (
              <form
                aria-label={t('record')}
                className={cx(card, 'flex flex-col gap-2')}
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const created = await session.api<{ id: string }>(`${base}/complaints`, {
                      method: 'POST',
                      body: {
                        categoryId: form.categoryId,
                        summary: form.summary,
                        ...(form.roomId ? { roomId: form.roomId } : {}),
                      },
                    });
                    setForm({ categoryId: '', roomId: '', summary: '' });
                    await load();
                    await openComplaint(created.id);
                  }, t('recorded'));
                }}
              >
                <h2 className="font-bold">{t('record')}</h2>
                <div className="grid grid-cols-2 gap-2">
                  <label className={label}>
                    {t('category')}
                    <select
                      className={field}
                      value={form.categoryId}
                      onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                    >
                      <option value="">{t('choose')}</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={label}>
                    {t('room')}
                    <select
                      className={field}
                      value={form.roomId}
                      onChange={(e) => setForm({ ...form, roomId: e.target.value })}
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
                <label className={label}>
                  {t('what_happened')}
                  <textarea
                    className={field}
                    rows={2}
                    value={form.summary}
                    onChange={(e) => setForm({ ...form, summary: e.target.value })}
                  />
                </label>
                <div>
                  <Button
                    type="submit"
                    disabled={busy || !form.categoryId || form.summary.trim().length < 3}
                  >
                    {t('record')}
                  </Button>
                </div>
              </form>
            )}
            <h2 id="list-title" className="px-1 text-sm font-bold text-slate-500">
              {t('complaints')}
            </h2>
            {complaints.length === 0 && (
              <p className={cx(card, 'text-sm text-slate-500')}>{t('none')}</p>
            )}
            <ul className="flex flex-col gap-2">
              {complaints.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    data-complaint={c.number}
                    aria-pressed={open?.id === c.id}
                    onClick={() => void openComplaint(c.id).catch(fail)}
                    className={cx(
                      card,
                      'flex w-full flex-wrap items-center gap-2 text-start',
                      open?.id === c.id && 'ring-2 ring-[var(--brand-primary,#0f4c81)]',
                    )}
                  >
                    <span className="font-bold">#{c.number}</span>
                    <span className="text-sm">{c.categoryName}</span>
                    <Badge tone={SEVERITY_TONE[c.severity]}>{t(`severity.${c.severity}`)}</Badge>
                    <span className="ms-auto">
                      <Badge tone={STATUS_TONE[c.status]}>{t(`status.${c.status}`)}</Badge>
                    </span>
                    <span className="w-full truncate text-sm text-slate-700">{c.summary}</span>
                    <span className="w-full text-xs text-slate-500">{when(c.openedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-3 self-start" aria-labelledby="detail-title">
            {!open ? (
              <p id="detail-title" className={cx(card, 'text-sm text-slate-500')}>
                {t('pick')}
              </p>
            ) : (
              <>
                <div className={cx(card, 'flex flex-col gap-2')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="detail-title" className="text-lg font-bold">
                      {t('complaint_title', { number: open.number, category: open.categoryName })}
                    </h2>
                    {open.roomNumber && (
                      <span className="bg-brand-soft text-brand rounded-full px-2.5 py-0.5 text-sm font-bold">
                        {t('room_n', { room: open.roomNumber })}
                      </span>
                    )}
                    <span className="ms-auto flex gap-1" data-testid="status">
                      <Badge tone={SEVERITY_TONE[open.severity]}>
                        {t(`severity.${open.severity}`)}
                      </Badge>
                      <Badge tone={STATUS_TONE[open.status]}>{t(`status.${open.status}`)}</Badge>
                    </span>
                  </div>
                  <p className="text-sm">{open.summary}</p>
                  {open.source === 'AI_CANDIDATE' && (
                    <p className="text-xs text-slate-500">{t('from_ai')}</p>
                  )}
                  {can.manage && NEXT[open.status].length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {NEXT[open.status].map((to) => (
                        <Button
                          key={to}
                          variant={to === 'RESOLVED' ? 'primary' : 'secondary'}
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await session.api(`${base}/complaints/${open.id}/status`, {
                                method: 'POST',
                                body: { to, version: open.version },
                              });
                              await Promise.all([load(), openComplaint(open.id)]);
                            })
                          }
                        >
                          {t(
                            `move.${open.status === 'RESOLVED' && to === 'IN_PROGRESS' ? 'REOPEN' : to}`,
                          )}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>

                <div className={cx(card, 'flex flex-col gap-2')} aria-labelledby="evidence-title">
                  <h3 id="evidence-title" className="font-bold">
                    {t('evidence')}
                  </h3>
                  {open.evidence.length === 0 && (
                    <p className="text-sm text-slate-500">{t('no_evidence')}</p>
                  )}
                  <ul className="flex flex-col divide-y divide-slate-100">
                    {open.evidence.map((e) => (
                      <li key={e.id} className="flex flex-col gap-0.5 py-2" data-evidence={e.kind}>
                        <span className="text-xs font-semibold text-slate-500">
                          {t(`evidence_kind.${e.kind}`)} · {when(e.createdAt)}
                        </span>
                        <span className="text-sm whitespace-pre-wrap">{e.text}</span>
                      </li>
                    ))}
                  </ul>
                  {can.manage && open.status !== 'CLOSED' && (
                    <form
                      className="flex gap-2"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        void run(async () => {
                          await session.api(`${base}/complaints/${open.id}/notes`, {
                            method: 'POST',
                            body: { text: note },
                          });
                          setNote('');
                          await openComplaint(open.id);
                        });
                      }}
                    >
                      <input
                        aria-label={t('note')}
                        placeholder={t('note')}
                        className={cx(field, 'min-w-0 flex-1')}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                      <Button type="submit" variant="secondary" disabled={busy || !note.trim()}>
                        {t('add_note')}
                      </Button>
                    </form>
                  )}
                </div>

                <div className={cx(card, 'flex flex-col gap-2')} aria-labelledby="recovery-title">
                  <h3 id="recovery-title" className="font-bold">
                    {t('recovery')}
                  </h3>
                  {open.recovery.length === 0 && (
                    <p className="text-sm text-slate-500">{t('no_recovery')}</p>
                  )}
                  <ul className="flex flex-col divide-y divide-slate-100">
                    {open.recovery.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center gap-2 py-2 text-sm"
                        data-recovery={r.kind}
                      >
                        <span className="font-semibold">{t(`kind.${r.kind}`)}</span>
                        {r.amountMinor !== null && <span>{money(r.amountMinor, r.currency)}</span>}
                        {r.note && <span className="text-slate-500">{r.note}</span>}
                        <span className="ms-auto">
                          <Badge
                            tone={
                              r.status === 'DONE'
                                ? 'success'
                                : r.status === 'REJECTED'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {t(`recovery_status.${r.status}`)}
                          </Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {can.recover && open.status !== 'CLOSED' && (
                    <form
                      aria-label={t('add_recovery')}
                      className="flex flex-col gap-2 border-t border-slate-100 pt-3"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        const amount = Number(recovery.amount);
                        void run(
                          async () => {
                            await session.api(`${base}/complaints/${open.id}/recovery`, {
                              method: 'POST',
                              body: {
                                kind: recovery.kind,
                                ...(WITH_AMOUNT.has(recovery.kind) && amount > 0
                                  ? { amountMinor: Math.round(amount * 100) }
                                  : {}),
                                ...(recovery.note.trim() ? { note: recovery.note.trim() } : {}),
                              },
                            });
                            setRecovery({ kind: 'APOLOGY', amount: '', note: '' });
                            await openComplaint(open.id);
                          },
                          WITH_AMOUNT.has(recovery.kind)
                            ? t('sent_for_approval')
                            : t('recovery_done'),
                        );
                      }}
                    >
                      <div className="grid grid-cols-2 gap-2">
                        <label className={label}>
                          {t('recovery_kind')}
                          <select
                            className={field}
                            value={recovery.kind}
                            onChange={(e) =>
                              setRecovery({ ...recovery, kind: e.target.value as RecoveryKind })
                            }
                          >
                            {RECOVERY_KINDS.map((k) => (
                              <option key={k} value={k}>
                                {t(`kind.${k}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                        {WITH_AMOUNT.has(recovery.kind) && (
                          <label className={label}>
                            {t('amount')}
                            <input
                              className={field}
                              inputMode="decimal"
                              value={recovery.amount}
                              onChange={(e) => setRecovery({ ...recovery, amount: e.target.value })}
                            />
                          </label>
                        )}
                      </div>
                      <label className={label}>
                        {t('recovery_note')}
                        <input
                          className={field}
                          value={recovery.note}
                          onChange={(e) => setRecovery({ ...recovery, note: e.target.value })}
                        />
                      </label>
                      {WITH_AMOUNT.has(recovery.kind) && (
                        <p className="text-xs text-slate-500">{t('needs_approval')}</p>
                      )}
                      <div>
                        <Button type="submit" disabled={busy}>
                          {t('add_recovery')}
                        </Button>
                      </div>
                    </form>
                  )}
                </div>

                <div className={cx(card, 'flex flex-col gap-1')} aria-labelledby="history-title">
                  <h3 id="history-title" className="font-bold">
                    {t('history')}
                  </h3>
                  <ol className="flex flex-col gap-1 text-sm">
                    {open.history.map((h) => (
                      <li key={h.id} className="flex flex-wrap gap-2">
                        <span className="text-slate-500">{when(h.createdAt)}</span>
                        <span>{t(`status.${h.toStatus}`)}</span>
                        {h.note && <span className="text-slate-500">— {h.note}</span>}
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
