'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { useMe } from '../lib/access';
import { ApiError, useSession } from '../lib/session';

// ---- shapes of the control-plane API (licensing context, Spec §58–§63) ----
interface Tenant {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}
interface CatalogEntry {
  readonly code: string;
  readonly kind: 'MODULE' | 'AI' | 'CONNECTOR' | 'ADDON' | 'FEATURE';
  readonly status: string;
  readonly name: string;
}
interface Catalog {
  readonly capabilities: readonly CatalogEntry[];
  readonly metrics: ReadonlyArray<{ code: string; name: string }>;
}
interface PlanVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly version?: number;
  readonly items?: readonly string[];
}
interface Plan {
  readonly id: string;
  readonly code: string;
  readonly translations: ReadonlyArray<{ locale: string; name: string }>;
  readonly versions: readonly PlanVersion[];
}
interface Subscription {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
  readonly scope: string;
  readonly version?: number;
  readonly plan: { readonly code: string; readonly versionNo: number } | null;
}
interface Grant {
  readonly id: string;
  readonly capabilityCode: string;
  readonly reason: string;
  readonly revokedAt: string | null;
}
interface Effective {
  readonly entitlements: ReadonlyArray<{ code: string }>;
  readonly limits: ReadonlyArray<{
    metricCode: string;
    scope: string;
    period: string;
    limitValue: number;
    enforcement: string;
  }>;
}
interface Usage {
  readonly rows: ReadonlyArray<{ metricCode: string; quantity: number }>;
}
interface Attribution {
  readonly show: boolean;
  readonly whiteLabelEntitled: boolean;
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  ACTIVE: 'success',
  TRIAL: 'info',
  PAST_DUE: 'warning',
  SUSPENDED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};
const KINDS = ['MODULE', 'AI', 'CONNECTOR', 'ADDON'] as const;

function monthWindow(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * The SaaS control plane for Planova's platform administrators (Spec §63): tenants and their licences, plans with
 * immutable versions. It shows no guest or operational data; hotel staff never see it.
 */
export function ControlApp() {
  const t = useTranslations('staff.control');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const me = useMe();
  const [tab, setTab] = useState<'tenants' | 'plans'>('tenants');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );
  const admin = me?.user.isPlatformAdmin === true;
  const loadPlans = useCallback(() => {
    session.api<Plan[]>('/control/license/plans').then(setPlans).catch(fail);
  }, [session, fail]);
  useEffect(() => {
    if (!admin) return;
    session.api<Catalog>('/control/license/catalog').then(setCatalog).catch(fail);
    loadPlans();
  }, [session, admin, fail, loadPlans]);

  async function act<T>(action: () => Promise<T>, done: string): Promise<T | null> {
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      setNotice(done);
      return result;
    } catch (e) {
      fail(e);
      return null;
    }
  }

  if (session.state !== 'signed-in') return <Header />;
  if (me && !admin)
    return (
      <>
        <Header />
        <p className="p-6 text-sm text-slate-600">{t('not_admin')}</p>
      </>
    );
  return (
    <>
      <Header />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 text-sm">
        <h1 className="text-base font-bold">{t('title')}</h1>
        <div className="flex gap-1" role="tablist">
          {(['tenants', 'plans'] as const).map((x) => (
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
        <span className="ms-auto text-xs text-slate-500">{t('no_guest_data')}</span>
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
      {tab === 'tenants' ? (
        <Tenants catalog={catalog} plans={plans} act={act} fail={fail} />
      ) : (
        <Plans catalog={catalog} plans={plans} reload={loadPlans} act={act} />
      )}
    </>
  );
}

type Act = <T>(action: () => Promise<T>, done: string) => Promise<T | null>;

function planName(plan: Plan, locale: string): string {
  return (
    plan.translations.find((x) => x.locale === locale)?.name ??
    plan.translations[0]?.name ??
    plan.code
  );
}

function Tenants({
  catalog,
  plans,
  act,
  fail,
}: {
  readonly catalog: Catalog | null;
  readonly plans: Plan[] | null;
  readonly act: Act;
  readonly fail: (e: unknown) => void;
}) {
  const t = useTranslations('staff.control');
  const session = useSession();
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [overview, setOverview] = useState<Subscription[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [attribution, setAttribution] = useState<Attribution | null>(null);
  const [reason, setReason] = useState('');
  const [planVersion, setPlanVersion] = useState('');
  const [capability, setCapability] = useState('');

  useEffect(() => {
    session.api<Tenant[]>('/tenants').then(setTenants).catch(fail);
    session.api<Subscription[]>('/control/subscriptions').then(setOverview).catch(fail);
  }, [session, fail]);

  const load = useCallback(
    (id: string) => {
      const base = `/control/tenants/${id}`;
      const { from, to } = monthWindow();
      session.api<Subscription[]>(`${base}/subscriptions`).then(setSubs).catch(fail);
      session.api<Grant[]>(`${base}/grants`).then(setGrants).catch(fail);
      session.api<Effective>(`${base}/entitlements`).then(setEffective).catch(fail);
      session
        .api<Usage>(`${base}/usage?granularity=MONTH&from=${from}&to=${to}`)
        .then(setUsage)
        .catch(fail);
      session.api<Attribution>(`${base}/attribution`).then(setAttribution).catch(fail);
    },
    [session, fail],
  );
  useEffect(() => {
    if (tenantId) load(tenantId);
  }, [tenantId, load]);

  const published = useMemo(
    () =>
      (plans ?? []).flatMap((p) =>
        p.versions
          .filter((v) => v.status === 'PUBLISHED')
          .map((v) => ({ id: v.id, label: `${p.code} · v${v.versionNo}` })),
      ),
    [plans],
  );
  const statusOf = (id: string) => overview.find((s) => s.tenantId === id)?.status ?? null;
  const base = `/control/tenants/${tenantId}`;
  const needReason = reason.trim().length >= 3;
  const after = async (r: unknown) => {
    if (r && tenantId) {
      load(tenantId);
      session.api<Subscription[]>('/control/subscriptions').then(setOverview).catch(fail);
    }
  };

  return (
    <main className="grid gap-4 p-4 md:grid-cols-[18rem_1fr]">
      <ul className="flex flex-col gap-1" aria-label={t('tenants')}>
        {tenants?.map((x) => {
          const status = statusOf(x.id);
          return (
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
                <span className="ms-auto">
                  {status ? (
                    <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
                  ) : (
                    <Badge tone="warning">{t('unlicensed')}</Badge>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!tenantId ? (
        <p className="text-sm text-slate-500">{t('pick_tenant')}</p>
      ) : (
        <section className="flex flex-col gap-4" aria-label={t('licence')}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">{t('reason')}</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reason_hint')}
              className="rounded-lg border border-slate-300 px-3 py-1.5"
            />
          </label>

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
            <h2 className="mb-2 font-bold">{t('subscriptions')}</h2>
            {subs.length === 0 && <p className="text-sm text-slate-500">{t('no_subscription')}</p>}
            <ul className="flex flex-col gap-2">
              {subs.map((s) => (
                <li
                  key={s.id}
                  data-subscription={s.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="font-semibold">
                    {s.plan ? `${s.plan.code} · v${s.plan.versionNo}` : '—'}
                  </span>
                  <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{t(`status.${s.status}`)}</Badge>
                  <span className="text-xs text-slate-500">{t(`scope.${s.scope}`)}</span>
                  <span className="ms-auto flex gap-1">
                    {(s.status === 'ACTIVE' || s.status === 'TRIAL' || s.status === 'PAST_DUE') && (
                      <Button
                        variant="ghost"
                        disabled={!needReason}
                        onClick={() =>
                          act(
                            () =>
                              session.api(`${base}/subscriptions/${s.id}/transition`, {
                                method: 'POST',
                                body: { version: s.version, status: 'SUSPENDED', reason },
                              }),
                            t('done'),
                          ).then(after)
                        }
                      >
                        {t('suspend')}
                      </Button>
                    )}
                    {s.status === 'SUSPENDED' && (
                      <Button
                        variant="ghost"
                        disabled={!needReason}
                        onClick={() =>
                          act(
                            () =>
                              session.api(`${base}/subscriptions/${s.id}/transition`, {
                                method: 'POST',
                                body: { version: s.version, status: 'ACTIVE', reason },
                              }),
                            t('done'),
                          ).then(after)
                        }
                      >
                        {t('resume')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <form
              className="mt-3 flex flex-wrap items-center gap-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void act(
                  () =>
                    session.api(`${base}/subscriptions`, {
                      method: 'POST',
                      body: { planVersionId: planVersion, reason: reason || undefined },
                    }),
                  t('done'),
                ).then(after);
              }}
            >
              <select
                aria-label={t('plan')}
                value={planVersion}
                onChange={(e) => setPlanVersion(e.target.value)}
                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm"
              >
                <option value="">{t('pick_plan')}</option>
                {published.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={!planVersion}>
                {t('subscribe')}
              </Button>
            </form>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
            <h2 className="mb-2 font-bold">{t('entitlements')}</h2>
            <ul className="flex flex-wrap gap-1.5" aria-label={t('entitlements')}>
              {effective?.entitlements.map((e) => (
                <li
                  key={e.code}
                  data-entitlement={e.code}
                  className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700"
                >
                  {catalog?.capabilities.find((c) => c.code === e.code)?.name ?? e.code}
                </li>
              ))}
            </ul>
            {effective && effective.limits.length > 0 && (
              <ul className="mt-2 text-xs text-slate-600">
                {effective.limits.map((l) => (
                  <li key={`${l.metricCode}-${l.scope}`}>
                    {t('limit', {
                      metric:
                        catalog?.metrics.find((m) => m.code === l.metricCode)?.name ?? l.metricCode,
                      value: l.limitValue,
                      enforcement: t(`enforcement.${l.enforcement}`),
                    })}
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mt-3 text-sm font-semibold">{t('grants')}</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {grants.map((g) => (
                <li key={g.id} className="flex items-center gap-2">
                  <span className={cx(g.revokedAt && 'text-slate-400 line-through')}>
                    {catalog?.capabilities.find((c) => c.code === g.capabilityCode)?.name ??
                      g.capabilityCode}
                  </span>
                  <span className="text-xs text-slate-500">{g.reason}</span>
                  {!g.revokedAt && (
                    <Button
                      variant="ghost"
                      className="ms-auto"
                      disabled={!needReason}
                      onClick={() =>
                        act(
                          () =>
                            session.api(`${base}/grants/${g.id}/revoke`, {
                              method: 'POST',
                              body: { reason },
                            }),
                          t('done'),
                        ).then(after)
                      }
                    >
                      {t('revoke')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void act(
                  () =>
                    session.api(`${base}/grants`, {
                      method: 'POST',
                      body: { capabilityCode: capability, reason },
                    }),
                  t('done'),
                ).then(after);
              }}
            >
              <select
                aria-label={t('capability')}
                value={capability}
                onChange={(e) => setCapability(e.target.value)}
                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm"
              >
                <option value="">{t('pick_capability')}</option>
                {catalog?.capabilities
                  .filter((c) => c.status === 'ACTIVE')
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
              </select>
              <Button type="submit" disabled={!capability || !needReason}>
                {t('grant')}
              </Button>
            </form>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
              <h2 className="mb-2 font-bold">{t('usage')}</h2>
              {usage && usage.rows.length === 0 && (
                <p className="text-sm text-slate-500">{t('no_usage')}</p>
              )}
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                {usage?.rows.map((u) => (
                  <div key={u.metricCode} className="contents" data-usage={u.metricCode}>
                    <dt>
                      {catalog?.metrics.find((m) => m.code === u.metricCode)?.name ?? u.metricCode}
                    </dt>
                    <dd className="text-end font-semibold tabular-nums">{u.quantity}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
              <h2 className="mb-2 font-bold">{t('white_label')}</h2>
              {attribution && (
                <>
                  <p className="text-sm" data-testid="attribution-state">
                    {attribution.show ? t('attribution_shown') : t('attribution_hidden')}
                  </p>
                  {!attribution.whiteLabelEntitled && attribution.show && (
                    <p className="mt-1 text-xs text-slate-500">{t('white_label_needed')}</p>
                  )}
                  <Button
                    variant="ghost"
                    className="mt-2"
                    disabled={!needReason || (attribution.show && !attribution.whiteLabelEntitled)}
                    onClick={() =>
                      act(
                        () =>
                          session.api(`${base}/attribution`, {
                            method: 'PUT',
                            body: { showPoweredBy: !attribution.show, reason },
                          }),
                        t('done'),
                      ).then(after)
                    }
                  >
                    {attribution.show ? t('hide_attribution') : t('show_attribution')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function Plans({
  catalog,
  plans,
  reload,
  act,
}: {
  readonly catalog: Catalog | null;
  readonly plans: Plan[] | null;
  readonly reload: () => void;
  readonly act: Act;
}) {
  const t = useTranslations('staff.control');
  const session = useSession();
  const [planId, setPlanId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [items, setItems] = useState<Set<string>>(new Set());
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');

  const loadPlan = useCallback(
    (id: string) =>
      session
        .api<Plan>(`/control/license/plans/${id}`)
        .then((p) => {
          setPlan(p);
          setItems(new Set(p.versions.find((v) => v.status === 'DRAFT')?.items ?? []));
        })
        .catch(() => undefined),
    [session],
  );
  useEffect(() => {
    if (planId) void loadPlan(planId);
  }, [planId, loadPlan]);

  const draft = plan?.versions.find((v) => v.status === 'DRAFT') ?? null;
  const locale = typeof document !== 'undefined' ? document.documentElement.lang : 'en';
  const refresh = (r: unknown) => {
    if (r && planId) void loadPlan(planId);
    if (r) reload();
  };

  return (
    <main className="grid gap-4 p-4 md:grid-cols-[18rem_1fr]">
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1" aria-label={t('plans')}>
          {plans?.map((p) => (
            <li key={p.id}>
              <button
                data-plan={p.code}
                onClick={() => setPlanId(p.id)}
                className={cx(
                  'flex w-full flex-col rounded-xl px-3 py-2 text-start text-sm',
                  p.id === planId ? 'bg-brand-soft' : 'bg-white hover:bg-slate-50',
                )}
              >
                <span className="font-semibold">{planName(p, locale)}</span>
                <span className="text-xs text-slate-500">
                  {p.code} ·{' '}
                  {p.versions.map((v) => `v${v.versionNo} ${t(`version.${v.status}`)}`).join(', ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <form
          aria-label={t('new_plan')}
          className="flex flex-col gap-2 rounded-2xl bg-white p-3 text-sm shadow-sm ring-1 ring-slate-900/5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(
              () =>
                session.api<Plan>('/control/license/plans', {
                  method: 'POST',
                  body: {
                    code,
                    translations: [
                      { locale: 'en', name: nameEn },
                      ...(nameAr.trim() ? [{ locale: 'ar', name: nameAr }] : []),
                    ],
                  },
                }),
              t('done'),
            ).then((p) => {
              if (!p) return;
              setCode('');
              setNameEn('');
              setNameAr('');
              reload();
              setPlanId(p.id);
            });
          }}
        >
          <h2 className="font-bold">{t('new_plan')}</h2>
          <input
            aria-label={t('plan_code')}
            placeholder="PRO"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            className="rounded-lg border border-slate-300 px-3 py-1.5"
          />
          <input
            aria-label={t('plan_name_en')}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5"
          />
          <input
            aria-label={t('plan_name_ar')}
            dir="rtl"
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5"
          />
          <Button type="submit" disabled={!/^[A-Z][A-Z0-9_]{1,63}$/.test(code) || !nameEn.trim()}>
            {t('create')}
          </Button>
        </form>
      </div>
      {!plan ? (
        <p className="text-sm text-slate-500">{t('pick_plan_edit')}</p>
      ) : (
        <section className="flex flex-col gap-3" aria-label={planName(plan, locale)}>
          <h2 className="text-lg font-bold">{planName(plan, locale)}</h2>
          {draft ? (
            <>
              <p className="text-sm text-slate-600">
                {t('draft_note', { version: draft.versionNo })}
              </p>
              {KINDS.map((kind) => (
                <fieldset
                  key={kind}
                  className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-900/5"
                >
                  <legend className="px-1 text-sm font-semibold">{t(`kind.${kind}`)}</legend>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {catalog?.capabilities
                      .filter((c) => c.kind === kind && c.status === 'ACTIVE')
                      .map((c) => (
                        <label key={c.code} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={items.has(c.code)}
                            onChange={(e) => {
                              const next = new Set(items);
                              if (e.target.checked) next.add(c.code);
                              else next.delete(c.code);
                              setItems(next);
                            }}
                          />
                          {c.name}
                        </label>
                      ))}
                  </div>
                </fieldset>
              ))}
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() =>
                    act(
                      () =>
                        session.api(`/control/license/plans/${plan.id}/versions/${draft.id}`, {
                          method: 'PUT',
                          body: { version: draft.version, items: [...items] },
                        }),
                      t('saved'),
                    ).then(refresh)
                  }
                >
                  {t('save_draft')}
                </Button>
                <Button
                  onClick={() =>
                    act(
                      () =>
                        session.api(
                          `/control/license/plans/${plan.id}/versions/${draft.id}/publish`,
                          { method: 'POST', body: { version: draft.version } },
                        ),
                      t('published'),
                    ).then(refresh)
                  }
                >
                  {t('publish')}
                </Button>
              </div>
              <p className="text-xs text-slate-500">{t('publish_note')}</p>
            </>
          ) : (
            <Button
              onClick={() =>
                act(
                  () =>
                    session.api(`/control/license/plans/${plan.id}/versions`, {
                      method: 'POST',
                      body: {},
                    }),
                  t('done'),
                ).then(refresh)
              }
            >
              {t('new_draft')}
            </Button>
          )}
        </section>
      )}
    </main>
  );
}
