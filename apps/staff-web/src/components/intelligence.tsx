'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { Insight, ManagerAnswer, Pulse, QualityRow } from '../lib/types';

type Tab = 'insights' | 'pulse' | 'quality';
const SEVERITY_TONE: Record<Insight['severity'], 'neutral' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'warning',
  HIGH: 'danger',
};
const SEVERITY_BAR: Record<Insight['severity'], string> = {
  LOW: 'bg-slate-400',
  MEDIUM: 'bg-amber-500',
  HIGH: 'bg-red-600',
};
const QUALITY_DAYS = 7;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Intelligence for the general manager and the duty manager (BUILD_PLAN 12.6): what the deterministic detectors found
 * (acknowledge, resolve or dismiss), the hotel's live counts, and the AI's quality. Numbers come from code; the
 * Manager assistant only explains them.
 */
export function IntelligenceApp() {
  const t = useTranslations('staff.intelligence');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } =
    usePropertiesWith('ai.insight.read');
  const { show: showBrand } = useStaffBrand();
  const [tab, setTab] = useState<Tab>('insights');
  const [error, setError] = useState<string | null>(null);

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

  if (session.state !== 'signed-in') return <Header />;
  const can = (permission: string) =>
    !!me && !!propertyId && permissionsAt(me, propertyId).has(permission);
  const tabs: Tab[] = [
    'insights',
    'pulse',
    ...(can('ai.quality.read') ? (['quality'] as const) : []),
  ];
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
            onChange={(e) => setPropertyId(e.target.value)}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex gap-1" role="tablist">
          {tabs.map((x) => (
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
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      ) : propertyId ? (
        <main className="flex flex-col gap-4 p-4">
          {tab === 'insights' && (
            <>
              {can('ai.manager.use') && <AskManager propertyId={propertyId} onError={fail} />}
              <Insights propertyId={propertyId} canAct={can('ai.insight.act')} onError={fail} />
            </>
          )}
          {tab === 'pulse' && <PulseView propertyId={propertyId} onError={fail} />}
          {tab === 'quality' && <Quality propertyId={propertyId} onError={fail} />}
        </main>
      ) : null}
    </>
  );
}

/** The live insights, HIGH first; each with its reason, evidence size, confidence and what to do. */
function Insights({
  propertyId,
  canAct,
  onError,
}: {
  readonly propertyId: string;
  readonly canAct: boolean;
  readonly onError: (e: unknown) => void;
}) {
  const t = useTranslations('staff.intelligence');
  const tAi = useTranslations('ai');
  const format = useFormatter();
  const session = useSession();
  const [list, setList] = useState<Insight[] | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    session.api<Insight[]>(`/properties/${propertyId}/insights`).then(setList).catch(onError);
  }, [session, propertyId, onError]);
  useEffect(() => {
    setList(null);
    load();
  }, [load]);

  const act = async (
    insight: Insight,
    action: 'acknowledge' | 'resolve' | 'dismiss',
    why?: string,
  ) => {
    try {
      await session.api(`/properties/${propertyId}/insights/${insight.id}/${action}`, {
        method: 'POST',
        body: { version: insight.version, ...(why ? { reason: why } : {}) },
      });
      setDismissing(null);
      setReason('');
      load();
    } catch (e) {
      onError(e);
    }
  };
  // Reason and action keys are the shared catalog's `ai.*` keys (the detectors store codes, not text).
  const text = (key: string, params: Readonly<Record<string, string | number>>) =>
    key.startsWith('ai.') && tAi.has(key.slice(3)) ? tAi(key.slice(3), params) : key;

  if (!list) return <p className="text-sm text-slate-500">{t('loading')}</p>;
  return (
    <section aria-label={t('tab.insights')} className="flex flex-col gap-3">
      <p className="text-xs text-slate-500">{t('rules_note')}</p>
      {list.length === 0 && <p className="text-sm text-slate-500">{t('none')}</p>}
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((insight) => (
          <li
            key={insight.id}
            data-insight={insight.id}
            data-severity={insight.severity}
            className="relative flex flex-col gap-2 overflow-hidden rounded-2xl bg-white p-4 ps-5 shadow-sm ring-1 ring-slate-900/5"
          >
            <span
              aria-hidden
              className={cx('absolute inset-y-0 start-0 w-1.5', SEVERITY_BAR[insight.severity])}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold">
                {text(`ai.insight.detector.${insight.detector.toLowerCase()}`, {})}
              </span>
              <span className="ms-auto">
                <Badge tone={SEVERITY_TONE[insight.severity]}>
                  {t(`severity.${insight.severity}`)}
                </Badge>
              </span>
            </div>
            <p className="text-sm">{text(insight.reasonKey, insight.reasonParams)}</p>
            {insight.suggestedAction && (
              <p className="text-sm font-medium text-brand">
                {text(insight.suggestedAction.key, insight.suggestedAction.params)}
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>
                {t('confidence', {
                  value: format.number(insight.confidence, { style: 'percent' }),
                })}
              </span>
              <span>{t('seen', { time: format.relativeTime(new Date(insight.lastSeenAt)) })}</span>
              <span>{t(`status.${insight.status}`)}</span>
            </div>
            {canAct && (
              <div className="flex flex-wrap gap-2">
                {insight.status === 'OPEN' && (
                  <Button variant="secondary" onClick={() => void act(insight, 'acknowledge')}>
                    {t('acknowledge')}
                  </Button>
                )}
                <Button variant="secondary" onClick={() => void act(insight, 'resolve')}>
                  {t('resolve')}
                </Button>
                <Button variant="ghost" onClick={() => setDismissing(insight.id)}>
                  {t('dismiss')}
                </Button>
              </div>
            )}
            {dismissing === insight.id && (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim()) void act(insight, 'dismiss', reason.trim());
                }}
              >
                <input
                  aria-label={t('dismiss_reason')}
                  placeholder={t('dismiss_reason')}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button type="submit" variant="danger" disabled={!reason.trim()}>
                  {t('dismiss_confirm')}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One question to the Manager assistant; its answer reads the same numbers as the screen. */
function AskManager({
  propertyId,
  onError,
}: {
  readonly propertyId: string;
  readonly onError: (e: unknown) => void;
}) {
  const t = useTranslations('staff.intelligence');
  const session = useSession();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ManagerAnswer | null>(null);
  return (
    <section
      aria-label={t('ask.title')}
      className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5"
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (question.trim().length < 2) return;
          setBusy(true);
          try {
            setAnswer(
              await session.api<ManagerAnswer>(`/properties/${propertyId}/ai/manager`, {
                method: 'POST',
                body: { question: question.trim() },
              }),
            );
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          aria-label={t('ask.title')}
          placeholder={t('ask.placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" disabled={busy || question.trim().length < 2}>
          {busy ? t('ask.thinking') : t('ask.send')}
        </Button>
      </form>
      {answer && (
        <p data-testid="manager-answer" className="mt-3 whitespace-pre-line text-sm">
          {answer.outcome === 'ANSWERED' ? answer.answer : t(`ask.${answer.outcome}`)}
        </p>
      )}
      <p className="mt-2 text-xs text-slate-500">{t('ask.note')}</p>
    </section>
  );
}

/** The hotel right now: counts from code, never estimated. */
function PulseView({
  propertyId,
  onError,
}: {
  readonly propertyId: string;
  readonly onError: (e: unknown) => void;
}) {
  const t = useTranslations('staff.intelligence');
  const session = useSession();
  const [pulse, setPulse] = useState<Pulse | null>(null);
  useEffect(() => {
    setPulse(null);
    session.api<Pulse>(`/properties/${propertyId}/ai/pulse`).then(setPulse).catch(onError);
  }, [session, propertyId, onError]);
  if (!pulse) return <p className="text-sm text-slate-500">{t('loading')}</p>;
  const cards: Array<[string, number, Readonly<Record<string, number>> | null]> = [
    ['open_work', pulse.openWork.total, pulse.openWork.byDepartment],
    ['breaches', pulse.slaBreaches24h.total, pulse.slaBreaches24h.byDepartment],
    ['complaints', pulse.openComplaints.total, pulse.openComplaints.bySeverity],
    ['restricted', pulse.roomsRestricted.total, pulse.roomsRestricted.byKind],
    ['arrivals', pulse.arrivalsTomorrow.count, null],
    ['insights', pulse.liveInsights.total, pulse.liveInsights.bySeverity],
  ];
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t('tab.pulse')}>
      {cards.map(([key, total, by]) => (
        <li
          key={key}
          data-pulse={key}
          className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5"
        >
          <p className="text-sm text-slate-600">{t(`pulse.${key}`)}</p>
          <p className="text-3xl font-bold tabular-nums">{total}</p>
          {by && Object.keys(by).length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-slate-600">
              {Object.entries(by)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([code, n]) => (
                  <span key={code} className="rounded-full bg-slate-100 px-2 py-0.5">
                    <bdi>{code}</bdi> · {n}
                  </span>
                ))}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The latest value of each quality metric per assistant over the last week. */
function Quality({
  propertyId,
  onError,
}: {
  readonly propertyId: string;
  readonly onError: (e: unknown) => void;
}) {
  const t = useTranslations('staff.intelligence');
  const format = useFormatter();
  const session = useSession();
  const [rows, setRows] = useState<QualityRow[] | null>(null);
  useEffect(() => {
    setRows(null);
    session
      .api<QualityRow[]>(
        `/properties/${propertyId}/ai/quality?from=${day(-QUALITY_DAYS)}&to=${day(0)}`,
      )
      .then(setRows)
      .catch(onError);
  }, [session, propertyId, onError]);
  if (!rows) return <p className="text-sm text-slate-500">{t('loading')}</p>;
  // The latest day of each agent and metric (rows come oldest first).
  const latest = new Map<string, QualityRow>();
  for (const r of rows) latest.set(`${r.agentCode}|${r.agentVersionId ?? ''}|${r.metric}`, r);
  const shown = [...latest.values()];
  if (shown.length === 0) return <p className="text-sm text-slate-500">{t('quality.none')}</p>;
  const value = (r: QualityRow) =>
    r.metric.endsWith('_rate') || r.metric.endsWith('_accuracy') || r.metric.endsWith('_acceptance')
      ? format.number(r.value, { style: 'percent', maximumFractionDigits: 1 })
      : format.number(r.value, { maximumFractionDigits: 2 });
  return (
    <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
      <table className="w-full text-start text-sm">
        <thead className="bg-slate-50 text-xs text-slate-600">
          <tr>
            <th className="px-3 py-2 text-start">{t('quality.agent')}</th>
            <th className="px-3 py-2 text-start">{t('quality.metric')}</th>
            <th className="px-3 py-2 text-end">{t('quality.value')}</th>
            <th className="px-3 py-2 text-end">{t('quality.samples')}</th>
            <th className="px-3 py-2 text-start">{t('quality.day')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr
              key={`${r.agentCode}|${r.agentVersionId}|${r.metric}`}
              data-metric={r.metric}
              className="border-t border-slate-100"
            >
              <td className="px-3 py-2">
                <bdi>{r.agentCode}</bdi>
              </td>
              <td className="px-3 py-2">{t(`metric.${r.metric}`)}</td>
              <td className="px-3 py-2 text-end tabular-nums">{value(r)}</td>
              <td className="px-3 py-2 text-end tabular-nums">{r.samples}</td>
              <td className="px-3 py-2">
                <bdi>{r.day}</bdi>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
