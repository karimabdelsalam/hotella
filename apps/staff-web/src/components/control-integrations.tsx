'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { useSession } from '../lib/session';

// ---- shapes of the commissioning API (integration context, BUILD_PLAN 10.9; guide §16, §20) ----
interface Tenant {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface Property {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface Reason {
  readonly code: string;
  readonly subject?: string;
  readonly count?: number;
}
interface Commissioning {
  readonly ready: boolean;
  readonly checklist: ReadonlyArray<{
    item: string;
    state: 'DONE' | 'OPEN' | 'NOT_APPLICABLE';
    reasons: readonly Reason[];
  }>;
  readonly sheet: ReadonlyArray<{
    requirement: string;
    scope: string;
    required: boolean;
    current: { status: string; hotelValue: string | null } | null;
  }>;
  readonly instances: ReadonlyArray<{
    id: string;
    connectorCode: string;
    name: string;
    health: string | null;
    commissionedAt: string | null;
    unverified: readonly string[];
    lastRun: { status: 'PASSED' | 'FAILED' } | null;
    profileGaps: ReadonlyArray<{ record: string; gaps: readonly string[] }> | null;
  }>;
}

type Act = <T>(action: () => Promise<T>, done: string) => Promise<T | null>;

const STATE_TONE = { DONE: 'success', OPEN: 'warning', NOT_APPLICABLE: 'neutral' } as const;
const SHEET_STATUSES = ['MATCH', 'GAP', 'CHANGE_REQUIRED', 'NOT_APPLICABLE'] as const;

/**
 * Commissioning of a property's PMS integration for Planova's installers (guide §16, §20): the readiness checklist,
 * each connector with its verification run, capabilities to verify and profile gaps, and the Interface Sheet. Interface
 * settings and counts only — no guest data. Hotel staff never see it.
 */
export function Integrations({
  act,
  fail,
}: {
  readonly act: Act;
  readonly fail: (e: unknown) => void;
}) {
  const t = useTranslations('staff.control');
  const session = useSession();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [view, setView] = useState<Commissioning | null>(null);
  const [evidence, setEvidence] = useState('');
  const [sample, setSample] = useState({ confirmationNumber: '', profileId: '' });
  const [drafts, setDrafts] = useState<Record<string, { status: string; hotelValue: string }>>({});

  useEffect(() => {
    session.api<Tenant[]>('/tenants').then(setTenants).catch(fail);
  }, [session, fail]);
  useEffect(() => {
    setPropertyId(null);
    setView(null);
    if (tenantId)
      session.api<Property[]>(`/properties?tenantId=${tenantId}`).then(setProperties).catch(fail);
  }, [session, tenantId, fail]);
  const base = `/properties/${propertyId}/integration`;
  const load = useCallback(() => {
    if (!propertyId) return;
    session
      .api<Commissioning>(`/properties/${propertyId}/integration/commissioning`)
      .then(setView)
      .catch(fail);
  }, [session, propertyId, fail]);
  useEffect(load, [load]);

  const hasEvidence = evidence.trim().length >= 3;
  const reason = (r: Reason) =>
    t(`commissioning.reason.${r.code}`, { subject: r.subject ?? '', count: r.count ?? 0 });
  const after = (r: unknown) => {
    if (r) load();
  };

  return (
    <main className="grid gap-4 p-4 md:grid-cols-[18rem_1fr]">
      <nav className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1" aria-label={t('tenants')}>
          {tenants?.map((x) => (
            <li key={x.id}>
              <button
                data-tenant={x.code}
                aria-current={x.id === tenantId ? 'true' : undefined}
                onClick={() => setTenantId(x.id)}
                className={cx(
                  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-start text-sm',
                  x.id === tenantId ? 'bg-brand-soft' : 'bg-white hover:bg-slate-50',
                )}
              >
                <span className="font-semibold">{x.name}</span>
                <span className="text-xs text-slate-500">{x.code}</span>
              </button>
            </li>
          ))}
        </ul>
        {tenantId && (
          <ul className="flex flex-col gap-1" aria-label={t('commissioning.properties')}>
            {properties.map((p) => (
              <li key={p.id}>
                <button
                  data-property={p.code}
                  aria-current={p.id === propertyId ? 'true' : undefined}
                  onClick={() => setPropertyId(p.id)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-xl px-3 py-1.5 text-start text-sm',
                    p.id === propertyId ? 'bg-brand-soft' : 'bg-white hover:bg-slate-50',
                  )}
                >
                  <span>{p.name}</span>
                  <span className="text-xs text-slate-500">{p.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {!tenantId ? (
        <p className="text-sm text-slate-500">{t('commissioning.pick_tenant')}</p>
      ) : !propertyId || !view ? (
        <p className="text-sm text-slate-500">{t('commissioning.pick_property')}</p>
      ) : (
        <section className="flex flex-col gap-4" aria-label={t('tab.integrations')}>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={view.ready ? 'success' : 'warning'}>
              {view.ready ? t('commissioning.ready') : t('commissioning.not_ready')}
            </Badge>
            <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
              <span className="font-semibold">{t('commissioning.evidence')}</span>
              <input
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder={t('commissioning.evidence_hint')}
                className="rounded-lg border border-slate-300 px-3 py-1.5"
              />
            </label>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
            <h2 className="mb-2 font-bold">{t('commissioning.checklist')}</h2>
            <ul className="flex flex-col gap-2" aria-label={t('commissioning.checklist')}>
              {view.checklist.map((i) => (
                <li key={i.item} data-item={i.item} className="flex flex-col gap-0.5 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge tone={STATE_TONE[i.state]}>{t(`commissioning.state.${i.state}`)}</Badge>
                    <span>{t(`commissioning.item.${i.item}`)}</span>
                  </span>
                  {i.reasons.length > 0 && (
                    <ul className="ms-6 list-disc text-xs text-slate-600">
                      {i.reasons.map((r, n) => (
                        <li key={n}>{reason(r)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
            <h2 className="mb-2 font-bold">{t('commissioning.instances')}</h2>
            <div className="mb-3 flex flex-wrap gap-2 text-sm">
              <input
                aria-label={t('commissioning.sample_confirmation')}
                placeholder={t('commissioning.sample_confirmation')}
                value={sample.confirmationNumber}
                onChange={(e) => setSample({ ...sample, confirmationNumber: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-1.5"
              />
              <input
                aria-label={t('commissioning.sample_profile')}
                placeholder={t('commissioning.sample_profile')}
                value={sample.profileId}
                onChange={(e) => setSample({ ...sample, profileId: e.target.value })}
                className="rounded-lg border border-slate-300 px-3 py-1.5"
              />
            </div>
            <ul className="flex flex-col gap-3">
              {view.instances.map((i) => (
                <li
                  key={i.id}
                  data-instance={i.connectorCode}
                  className="flex flex-col gap-1.5 rounded-xl border border-slate-200 p-3 text-sm"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{i.name}</span>
                    <span className="text-xs text-slate-500">{i.connectorCode}</span>
                    <Badge tone={i.health === 'HEALTHY' ? 'success' : 'warning'}>
                      {i.health
                        ? t('commissioning.health', { health: i.health })
                        : t('commissioning.no_health')}
                    </Badge>
                    {i.lastRun ? (
                      <Badge tone={i.lastRun.status === 'PASSED' ? 'success' : 'danger'}>
                        {t('commissioning.last_run', {
                          status: t(`commissioning.run_status.${i.lastRun.status}`),
                        })}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">{t('commissioning.never_run')}</Badge>
                    )}
                    {i.commissionedAt && (
                      <Badge tone="info">{t('commissioning.commissioned')}</Badge>
                    )}
                    <span className="ms-auto flex gap-1">
                      <Button
                        variant="ghost"
                        onClick={() =>
                          act(
                            () =>
                              session.api(`${base}/commissioning/runs`, {
                                method: 'POST',
                                body: {
                                  instanceId: i.id,
                                  sample: {
                                    confirmationNumber: sample.confirmationNumber || undefined,
                                    profileId: sample.profileId || undefined,
                                  },
                                },
                              }),
                            t('commissioning.ran'),
                          ).then(after)
                        }
                      >
                        {t('commissioning.run')}
                      </Button>
                      {!i.commissionedAt && (
                        <Button
                          disabled={!hasEvidence}
                          onClick={() =>
                            act(
                              () =>
                                session.api(`${base}/instances/${i.id}/commission`, {
                                  method: 'POST',
                                  body: { evidenceRef: evidence },
                                }),
                              t('commissioning.signed_off'),
                            ).then(after)
                          }
                        >
                          {t('commissioning.commission')}
                        </Button>
                      )}
                    </span>
                  </span>
                  {i.unverified.length === 0 ? (
                    <span className="text-xs text-slate-500">
                      {t('commissioning.all_verified')}
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1 text-xs">
                      <span className="text-slate-600">{t('commissioning.unverified')}</span>
                      {i.unverified.map((c) => (
                        <button
                          key={c}
                          data-verify={c}
                          disabled={!hasEvidence}
                          title={t('commissioning.verify')}
                          onClick={() =>
                            act(
                              () =>
                                session.api(`${base}/capabilities/${c}/verify`, {
                                  method: 'POST',
                                  body: { instanceId: i.id, evidenceRef: evidence },
                                }),
                              t('commissioning.verified'),
                            ).then(after)
                          }
                          className="rounded-full border border-slate-300 px-2 py-0.5 font-mono hover:bg-slate-50 disabled:opacity-50"
                        >
                          {c}
                        </button>
                      ))}
                    </span>
                  )}
                  {i.profileGaps && (
                    <span className="text-xs text-slate-600">
                      {i.profileGaps.some((g) => g.gaps.length > 0)
                        ? i.profileGaps
                            .filter((g) => g.gaps.length > 0)
                            .map((g) =>
                              t('commissioning.gaps', {
                                record: g.record,
                                fields: g.gaps.join(' '),
                              }),
                            )
                            .join(' · ')
                        : t('commissioning.no_gaps')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
            <h2 className="mb-2 font-bold">{t('commissioning.sheet')}</h2>
            <ul className="flex flex-col divide-y divide-slate-100">
              {view.sheet.map((r) => {
                const draft = drafts[r.requirement] ?? {
                  status: r.current?.status ?? '',
                  hotelValue: r.current?.hotelValue ?? '',
                };
                const setDraft = (d: Partial<typeof draft>) =>
                  setDrafts({ ...drafts, [r.requirement]: { ...draft, ...d } });
                return (
                  <li
                    key={r.requirement}
                    data-requirement={r.requirement}
                    className="flex flex-wrap items-center gap-2 py-2 text-sm"
                  >
                    <span className="min-w-56 flex-1">
                      <span className="block">
                        {t(`commissioning.requirement.${r.requirement}`)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {t(`commissioning.scope.${r.scope}`)}
                        {r.required ? ` · ${t('commissioning.required')}` : ''}
                      </span>
                    </span>
                    <select
                      aria-label={t(`commissioning.requirement.${r.requirement}`)}
                      value={draft.status}
                      onChange={(e) => setDraft({ status: e.target.value })}
                      className="rounded-lg border border-slate-300 px-2 py-1"
                    >
                      <option value="">{t('commissioning.not_stated')}</option>
                      {SHEET_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`commissioning.status.${s}`)}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={t('commissioning.hotel_value')}
                      placeholder={t('commissioning.hotel_value')}
                      value={draft.hotelValue}
                      onChange={(e) => setDraft({ hotelValue: e.target.value })}
                      className="w-44 rounded-lg border border-slate-300 px-2 py-1"
                    />
                    <Button
                      variant="ghost"
                      disabled={!draft.status}
                      onClick={() =>
                        act(
                          () =>
                            session.api(`${base}/commissioning/sheet/${r.requirement}`, {
                              method: 'PUT',
                              body: {
                                status: draft.status,
                                hotelValue: draft.hotelValue || undefined,
                              },
                            }),
                          t('commissioning.saved'),
                        ).then(after)
                      }
                    >
                      {t('commissioning.save')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}
    </main>
  );
}
