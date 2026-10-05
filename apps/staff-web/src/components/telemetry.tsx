'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { TelemetryAlarm, TelemetryPoint, TelemetryRule } from '../lib/types';

const SEVERITY_BAR: Record<TelemetryRule['severity'], string> = {
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-red-600',
};
const REFRESH_MS = 30_000;

/**
 * Building telemetry for engineering (BUILD_PLAN 13.2): the alarms that need someone now (acknowledge), and every
 * sensor with its latest reading. Rules decide by code; the screen only shows what they decided.
 */
export function TelemetryApp() {
  const t = useTranslations('staff.telemetry');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } =
    usePropertiesWith('eng.telemetry.read');
  const { show: showBrand } = useStaffBrand();
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
  const canAcknowledge =
    !!me && !!propertyId && permissionsAt(me, propertyId).has('eng.telemetry.acknowledge');
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
      </div>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      ) : propertyId ? (
        <Board propertyId={propertyId} canAcknowledge={canAcknowledge} onError={fail} />
      ) : null}
    </>
  );
}

function Board({
  propertyId,
  canAcknowledge,
  onError,
}: {
  readonly propertyId: string;
  readonly canAcknowledge: boolean;
  readonly onError: (e: unknown) => void;
}) {
  const t = useTranslations('staff.telemetry');
  const format = useFormatter();
  const session = useSession();
  const [data, setData] = useState<{
    points: TelemetryPoint[];
    rules: TelemetryRule[];
    alarms: TelemetryAlarm[];
  } | null>(null);

  const load = useCallback(() => {
    const base = `/properties/${propertyId}/eng/telemetry`;
    Promise.all([
      session.api<TelemetryPoint[]>(`${base}/points`),
      session.api<TelemetryRule[]>(`${base}/rules`),
      session.api<TelemetryAlarm[]>(`${base}/alarms?live=true`),
    ])
      .then(([points, rules, alarms]) => setData({ points, rules, alarms }))
      .catch(onError);
  }, [session, propertyId, onError]);
  useEffect(() => {
    setData(null);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const acknowledge = async (alarm: TelemetryAlarm) => {
    try {
      await session.api(`/properties/${propertyId}/eng/telemetry/alarms/${alarm.id}/acknowledge`, {
        method: 'POST',
        body: { version: alarm.version },
      });
      load();
    } catch (e) {
      onError(e);
    }
  };

  if (!data) return <p className="p-4 text-sm text-slate-500">{t('loading')}</p>;
  const points = new Map(data.points.map((p) => [p.id, p]));
  const rules = new Map(data.rules.map((r) => [r.id, r]));
  const reading = (point: TelemetryPoint | undefined, value: number | null) =>
    value === null || !point
      ? t('no_value')
      : `${format.number(value, { maximumFractionDigits: 2 })} ${point.unit}`;
  const label = (point: TelemetryPoint | undefined) => point?.name ?? point?.externalCode ?? '';
  // Critical first, then the oldest.
  const alarms = [...data.alarms].sort(
    (a, b) =>
      Number(rules.get(b.ruleId)?.severity === 'CRITICAL') -
        Number(rules.get(a.ruleId)?.severity === 'CRITICAL') ||
      a.raisedAt.localeCompare(b.raisedAt),
  );

  return (
    <main className="flex flex-col gap-6 p-4">
      <section aria-labelledby="telemetry-alarms" className="flex flex-col gap-3">
        <h2 id="telemetry-alarms" className="text-sm font-bold uppercase text-slate-500">
          {t('alarms')}
        </h2>
        {alarms.length === 0 && <p className="text-sm text-slate-500">{t('no_alarms')}</p>}
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {alarms.map((alarm) => {
            const point = points.get(alarm.pointId);
            const rule = rules.get(alarm.ruleId);
            const severity = rule?.severity ?? 'WARNING';
            return (
              <li
                key={alarm.id}
                data-alarm={alarm.id}
                data-severity={severity}
                className="relative flex flex-col gap-2 overflow-hidden rounded-2xl bg-white p-4 ps-5 shadow-sm ring-1 ring-slate-900/5"
              >
                <span
                  aria-hidden
                  className={cx('absolute inset-y-0 start-0 w-1.5', SEVERITY_BAR[severity])}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{label(point)}</span>
                  <span className="ms-auto">
                    <Badge tone={severity === 'CRITICAL' ? 'danger' : 'warning'}>
                      {t(`severity.${severity}`)}
                    </Badge>
                  </span>
                </div>
                <p className="text-sm">
                  {rule ? t(`rule.${rule.kind}`) : null}
                  {point ? ` · ${t(`quantity.${point.quantity}`)}` : null}
                </p>
                <p className="text-lg font-semibold tabular-nums" dir="ltr">
                  {reading(point, alarm.value)}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>{t('since', { time: format.relativeTime(new Date(alarm.raisedAt)) })}</span>
                  {alarm.peak !== null && alarm.peak !== alarm.value && (
                    <span>{t('peak', { value: reading(point, alarm.peak) })}</span>
                  )}
                  <span>{t(`status.${alarm.status}`)}</span>
                  {alarm.workOrderId && <span>{t('work_order')}</span>}
                </div>
                {canAcknowledge && alarm.status === 'OPEN' && (
                  <div>
                    <Button variant="secondary" onClick={() => void acknowledge(alarm)}>
                      {t('acknowledge')}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="telemetry-points" className="flex flex-col gap-3">
        <h2 id="telemetry-points" className="text-sm font-bold uppercase text-slate-500">
          {t('points')}
        </h2>
        {data.points.length === 0 ? (
          <p className="text-sm text-slate-500">{t('no_points')}</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5">
            <table className="w-full text-sm">
              <thead className="text-start text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-start font-semibold">{t('point')}</th>
                  <th className="px-4 py-2 text-start font-semibold">{t('measures')}</th>
                  <th className="px-4 py-2 text-start font-semibold">{t('latest')}</th>
                  <th className="px-4 py-2 text-start font-semibold">{t('updated')}</th>
                </tr>
              </thead>
              <tbody>
                {data.points.map((point) => (
                  <tr
                    key={point.id}
                    data-point={point.externalCode}
                    className={cx(
                      'border-t border-slate-100',
                      point.status === 'IGNORED' && 'text-slate-400',
                    )}
                  >
                    <td className="px-4 py-2">
                      <span className="font-medium">{label(point)}</span>
                      {point.status === 'IGNORED' && (
                        <span className="ms-2 text-xs">{t('ignored')}</span>
                      )}
                    </td>
                    <td className="px-4 py-2">{t(`quantity.${point.quantity}`)}</td>
                    <td className="px-4 py-2 tabular-nums" dir="ltr">
                      {reading(point, point.lastValue)}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {point.lastAt ? format.relativeTime(new Date(point.lastAt)) : t('never')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
