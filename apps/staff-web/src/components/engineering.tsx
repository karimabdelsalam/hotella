'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx, SparkleIcon } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { Asset, CopilotAnswer, FailureCode, WorkOrder } from '../lib/types';

type Tab = 'orders' | 'assets';
type CodeKind = FailureCode['kind'];
const CODE_FIELDS: ReadonlyArray<
  [CodeKind, 'symptomCode' | 'failureModeCode' | 'causeCode' | 'resolutionCode']
> = [
  ['SYMPTOM', 'symptomCode'],
  ['FAILURE_MODE', 'failureModeCode'],
  ['CAUSE', 'causeCode'],
  ['RESOLUTION', 'resolutionCode'],
];
const NEW_TYPES = ['CORRECTIVE', 'EMERGENCY', 'INSPECTION'] as const;
const STATUS_TONE: Record<WorkOrder['status'], 'neutral' | 'info' | 'success' | 'danger'> = {
  OPEN: 'info',
  IN_PROGRESS: 'info',
  DONE: 'success',
  CANCELLED: 'neutral',
};

/** `2026-10-03T10:00:00Z` ↔ the value of a `datetime-local` input, in the browser's time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

interface Coding {
  symptomCode: string;
  failureModeCode: string;
  causeCode: string;
  resolutionCode: string;
  diagnosis: string;
  downtimeStartedAt: string;
  downtimeEndedAt: string;
}
const codingOf = (w: WorkOrder): Coding => ({
  symptomCode: w.symptomCode ?? '',
  failureModeCode: w.failureModeCode ?? '',
  causeCode: w.causeCode ?? '',
  resolutionCode: w.resolutionCode ?? '',
  diagnosis: w.diagnosis ?? '',
  downtimeStartedAt: toLocalInput(w.downtimeStartedAt),
  downtimeEndedAt: toLocalInput(w.downtimeEndedAt),
});

/**
 * Engineering for staff (Spec §10, BUILD_PLAN 8.4): open work orders with their failure coding and close-out, the
 * property's assets with their history, and the Engineering Copilot, which only reads and explains. Logical
 * properties only, so the screen mirrors in Arabic.
 */
export function EngineeringApp() {
  const t = useTranslations('staff.eng');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const locale = useLocale();
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } =
    usePropertiesWith('eng.work_order.read');
  const { show: showBrand } = useStaffBrand();
  const [tab, setTab] = useState<Tab>('orders');
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [codes, setCodes] = useState<FailureCode[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [coding, setCoding] = useState<Coding | null>(null);
  const [asset, setAsset] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkOrder[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<CopilotAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState({ assetId: '', type: 'CORRECTIVE', symptomCode: '' });
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
    const perms = me && propertyId ? permissionsAt(me, propertyId) : new Set<string>();
    return {
      manage: perms.has('eng.work_order.manage'),
      ask: perms.has('eng.asset.read') && perms.has('eng.work_order.read'),
    };
  }, [me, propertyId]);

  const base = propertyId ? `/properties/${propertyId}/eng` : null;
  const load = useCallback(async () => {
    if (!base) return;
    const [list, all] = await Promise.all([
      session.api<WorkOrder[]>(`${base}/work-orders?status=OPEN,IN_PROGRESS`),
      session.api<Asset[]>(`${base}/assets`),
    ]);
    setOrders(list);
    setAssets(all);
  }, [session, base]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);
  useEffect(() => {
    if (session.state !== 'signed-in' || !propertyId) return;
    session.api<FailureCode[]>('/eng/failure-codes').then(setCodes).catch(fail);
  }, [session, propertyId, fail]);

  const nameOf = useMemo(() => {
    const names = new Map(
      codes.map((c) => [
        `${c.kind}:${c.code}`,
        c.translations.find((x) => x.locale === locale)?.name ??
          c.translations.find((x) => x.locale === 'en')?.name ??
          c.code,
      ]),
    );
    return (kind: CodeKind, code: string | null) =>
      code ? (names.get(`${kind}:${code}`) ?? code) : null;
  }, [codes, locale]);

  const order = orders.find((o) => o.id === selected) ?? null;
  useEffect(() => setCoding(order ? codingOf(order) : null), [order]);

  const currentAsset = assets.find((a) => a.id === asset) ?? null;
  useEffect(() => {
    setAnswer(null);
    if (!base || !asset) return setHistory([]);
    session.api<WorkOrder[]>(`${base}/work-orders?assetId=${asset}`).then(setHistory).catch(fail);
  }, [session, base, asset, fail]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice(done);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const codingBody = (c: Coding) => ({
    symptomCode: c.symptomCode || null,
    failureModeCode: c.failureModeCode || null,
    causeCode: c.causeCode || null,
    resolutionCode: c.resolutionCode || null,
    diagnosis: c.diagnosis.trim() || null,
    downtimeStartedAt: fromLocalInput(c.downtimeStartedAt),
    downtimeEndedAt: fromLocalInput(c.downtimeEndedAt),
  });

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!base || !question.trim()) return;
    setAsking(true);
    setAnswer(null);
    setError(null);
    try {
      setAnswer(
        await session.api<CopilotAnswer>(`${base}/copilot`, {
          method: 'POST',
          body: { question: question.trim(), ...(asset ? { assetId: asset } : {}) },
        }),
      );
    } catch (err) {
      fail(err);
    } finally {
      setAsking(false);
    }
  }

  const openAsset = (id: string | null) => {
    setAsset(id);
    setTab('assets');
  };

  if (session.state !== 'signed-in') return <Header />;
  const select =
    'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-start disabled:bg-slate-50';
  const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5';
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
              setSelected(null);
              setAsset(null);
            }}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-1" role="tablist">
          {(['orders', 'assets'] as const).map((x) => (
            <button
              key={x}
              role="tab"
              aria-selected={tab === x}
              onClick={() => setTab(x)}
              className={cx(
                'rounded-full px-3 py-1 text-sm font-semibold',
                tab === x ? 'bg-brand-soft text-brand' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t(`tab.${x}`)}
            </button>
          ))}
        </div>
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
      ) : tab === 'orders' ? (
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <section aria-labelledby="orders-title" className="flex flex-col gap-3">
            <h2 id="orders-title" className="px-1 text-sm font-bold text-slate-500">
              {t('open_orders', { count: orders.length })}
            </h2>
            {can.manage && (
              <form
                className={cx(card, 'flex flex-wrap items-end gap-2')}
                aria-label={t('new_order')}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!base || !draft.assetId) return;
                  void run(
                    () =>
                      session.api(`${base}/work-orders`, {
                        method: 'POST',
                        body: {
                          type: draft.type,
                          assetId: draft.assetId,
                          ...(draft.symptomCode ? { symptomCode: draft.symptomCode } : {}),
                        },
                      }),
                    t('created'),
                  ).then(() => setDraft({ assetId: '', type: 'CORRECTIVE', symptomCode: '' }));
                }}
              >
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
                  {t('asset')}
                  <select
                    className={select}
                    value={draft.assetId}
                    onChange={(e) => setDraft({ ...draft, assetId: e.target.value })}
                  >
                    <option value="">{t('choose')}</option>
                    {assets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.assetNumber} · {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  {t('type')}
                  <select
                    className={select}
                    value={draft.type}
                    onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                  >
                    {NEW_TYPES.map((x) => (
                      <option key={x} value={x}>
                        {t(`types.${x}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
                  {t('code.SYMPTOM')}
                  <select
                    className={select}
                    value={draft.symptomCode}
                    onChange={(e) => setDraft({ ...draft, symptomCode: e.target.value })}
                  >
                    <option value="">{t('choose')}</option>
                    {codes
                      .filter((c) => c.kind === 'SYMPTOM' && c.active)
                      .map((c) => (
                        <option key={c.id} value={c.code}>
                          {nameOf('SYMPTOM', c.code)}
                        </option>
                      ))}
                  </select>
                </label>
                <Button type="submit" disabled={busy || !draft.assetId}>
                  {t('new_order')}
                </Button>
              </form>
            )}
            {orders.length === 0 && (
              <p className={cx(card, 'text-sm text-slate-500')}>{t('no_orders')}</p>
            )}
            <ul className="flex flex-col gap-2">
              {orders.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    data-order={o.number}
                    aria-pressed={selected === o.id}
                    onClick={() => setSelected(o.id)}
                    className={cx(
                      card,
                      'flex w-full flex-col gap-1.5 text-start transition hover:shadow-md',
                      selected === o.id && 'ring-2 ring-[var(--brand-primary,#0f4c81)]',
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">#{o.number}</span>
                      <span className="text-sm text-slate-600">{t(`types.${o.type}`)}</span>
                      {o.roomNumber && (
                        <span className="bg-brand-soft text-brand rounded-full px-2 py-0.5 text-xs font-bold">
                          {t('room', { room: o.roomNumber })}
                        </span>
                      )}
                      <span className="ms-auto">
                        <Badge tone={STATUS_TONE[o.status]}>{t(`status.${o.status}`)}</Badge>
                      </span>
                    </span>
                    <span className="text-sm">
                      {o.assetNumber ? `${o.assetNumber} · ${o.assetName}` : t('no_asset')}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      {o.symptomCode && <span>{nameOf('SYMPTOM', o.symptomCode)}</span>}
                      <span>
                        {format.dateTime(new Date(o.reportedAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                      {o.codingMissing.length > 0 && (
                        <Badge tone="warning">{t('coding_missing')}</Badge>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section
            aria-labelledby="order-title"
            className={cx(card, 'flex flex-col gap-4 self-start')}
          >
            {!order || !coding ? (
              <p id="order-title" className="text-sm text-slate-500">
                {t('pick_order')}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="order-title" className="text-lg font-bold">
                    {t('order_title', { number: order.number })}
                  </h2>
                  <Badge tone={STATUS_TONE[order.status]}>{t(`status.${order.status}`)}</Badge>
                  {order.assetId && can.ask && (
                    <Button
                      variant="secondary"
                      className="ms-auto"
                      onClick={() => openAsset(order.assetId)}
                    >
                      <SparkleIcon className="size-4" />
                      {t('ask_about_asset')}
                    </Button>
                  )}
                </div>
                <p className="text-sm text-slate-600">
                  {[
                    order.assetNumber && `${order.assetNumber} · ${order.assetName}`,
                    order.roomNumber && t('room', { room: order.roomNumber }),
                  ]
                    .filter(Boolean)
                    .join(' — ')}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {CODE_FIELDS.map(([kind, field]) => (
                    <label
                      key={field}
                      className="flex flex-col gap-1 text-xs font-semibold text-slate-600"
                    >
                      {t(`code.${kind}`)}
                      <select
                        className={select}
                        disabled={!can.manage}
                        value={coding[field]}
                        onChange={(e) => setCoding({ ...coding, [field]: e.target.value })}
                      >
                        <option value="">{t('choose')}</option>
                        {codes
                          .filter((c) => c.kind === kind && (c.active || c.code === coding[field]))
                          .map((c) => (
                            <option key={c.id} value={c.code}>
                              {nameOf(kind, c.code)}
                            </option>
                          ))}
                      </select>
                    </label>
                  ))}
                </div>
                <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
                  {t('diagnosis')}
                  <textarea
                    className="min-h-20 rounded-xl border border-slate-300 px-3 py-2 text-sm text-start"
                    disabled={!can.manage}
                    value={coding.diagnosis}
                    maxLength={2000}
                    onChange={(e) => setCoding({ ...coding, diagnosis: e.target.value })}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['downtimeStartedAt', 'downtimeEndedAt'] as const).map((field) => (
                    <label
                      key={field}
                      className="flex flex-col gap-1 text-xs font-semibold text-slate-600"
                    >
                      {t(field === 'downtimeStartedAt' ? 'downtime_start' : 'downtime_end')}
                      <input
                        type="datetime-local"
                        dir="ltr"
                        className={select}
                        disabled={!can.manage}
                        value={coding[field]}
                        onChange={(e) => setCoding({ ...coding, [field]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                {can.manage && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            session.api(`${base}/work-orders/${order.id}`, {
                              method: 'PATCH',
                              body: { version: order.version, ...codingBody(coding) },
                            }),
                          t('saved'),
                        )
                      }
                    >
                      {t('save')}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            session.api(`${base}/work-orders/${order.id}/complete`, {
                              method: 'POST',
                              body: codingBody(coding),
                            }),
                          t('completed'),
                        ).then(() => setSelected(null))
                      }
                    >
                      {t('complete')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      ) : (
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <section aria-labelledby="assets-title" className="flex flex-col gap-2">
            <h2 id="assets-title" className="px-1 text-sm font-bold text-slate-500">
              {t('assets', { count: assets.length })}
            </h2>
            <ul className="flex flex-col gap-2">
              {assets.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    data-asset={a.assetNumber}
                    aria-pressed={asset === a.id}
                    onClick={() => setAsset(a.id)}
                    className={cx(
                      card,
                      'flex w-full items-center gap-3 text-start',
                      asset === a.id && 'ring-2 ring-[var(--brand-primary,#0f4c81)]',
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-bold">{a.assetNumber}</span>
                      <span className="truncate text-sm text-slate-600">{a.name}</span>
                    </span>
                    <Badge
                      tone={
                        a.criticality === 'CRITICAL' || a.criticality === 'HIGH'
                          ? 'warning'
                          : 'neutral'
                      }
                    >
                      {t(`criticality.${a.criticality}`)}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-4 self-start">
            {currentAsset && (
              <div className={card}>
                <h2 className="text-lg font-bold">
                  {currentAsset.assetNumber} · {currentAsset.name}
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  {t(`asset_status.${currentAsset.status}`)}
                  {currentAsset.warrantyUntil &&
                    ` — ${t('warranty_until', { date: format.dateTime(new Date(currentAsset.warrantyUntil), { dateStyle: 'medium' }) })}`}
                </p>
                <h3 className="mt-4 text-sm font-bold text-slate-500">{t('history')}</h3>
                {history.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500">{t('no_history')}</p>
                ) : (
                  <ul className="mt-2 flex flex-col divide-y divide-slate-100">
                    {history.map((w) => (
                      <li
                        key={w.id}
                        className="flex flex-wrap items-center gap-2 py-2 text-sm"
                        data-history={w.number}
                      >
                        <span className="font-semibold">#{w.number}</span>
                        <span className="text-slate-600">{t(`types.${w.type}`)}</span>
                        {w.failureModeCode && (
                          <span>{nameOf('FAILURE_MODE', w.failureModeCode)}</span>
                        )}
                        <span className="ms-auto">
                          <Badge tone={STATUS_TONE[w.status]}>{t(`status.${w.status}`)}</Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {can.ask && (
              <form
                onSubmit={ask}
                aria-labelledby="copilot-title"
                className={cx(card, 'flex flex-col gap-3')}
              >
                <div className="flex items-center gap-2">
                  <span className="bg-brand-soft text-brand inline-flex size-8 items-center justify-center rounded-full">
                    <SparkleIcon className="size-4" />
                  </span>
                  <h2 id="copilot-title" className="font-bold">
                    {t('copilot.title')}
                  </h2>
                </div>
                <p className="text-xs text-slate-500">
                  {currentAsset
                    ? t('copilot.about', { asset: currentAsset.assetNumber })
                    : t('copilot.hint')}
                </p>
                <textarea
                  aria-label={t('copilot.question')}
                  placeholder={t('copilot.placeholder')}
                  className="min-h-20 rounded-xl border border-slate-300 px-3 py-2 text-sm text-start"
                  value={question}
                  maxLength={1000}
                  onChange={(e) => setQuestion(e.target.value)}
                />
                <div>
                  <Button type="submit" disabled={asking || question.trim().length < 2}>
                    {asking ? t('copilot.thinking') : t('copilot.ask')}
                  </Button>
                </div>
                {answer && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-900/5"
                    data-testid="copilot-answer"
                  >
                    {answer.outcome === 'ANSWERED' ? (
                      <>
                        <p className="text-xs font-semibold text-slate-500">{t('copilot.label')}</p>
                        <p className="mt-1 text-sm leading-6 whitespace-pre-line" dir="auto">
                          {answer.answer}
                        </p>
                        {answer.sources.length > 0 && (
                          <p className="mt-2 text-xs text-slate-500">
                            {t('copilot.sources')}{' '}
                            {format.list(
                              answer.sources.map((s) => `${s.title} (v${s.versionNo})`),
                              { type: 'conjunction' },
                            )}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-slate-600">
                        {t(answer.outcome === 'DISABLED' ? 'copilot.disabled' : 'copilot.failed')}
                      </p>
                    )}
                  </div>
                )}
              </form>
            )}
          </section>
        </main>
      )}
    </>
  );
}
