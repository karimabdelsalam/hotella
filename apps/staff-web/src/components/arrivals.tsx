'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { ArrivalRisk } from '../lib/types';

type Day = 'today' | 'tomorrow';
const LEVEL_TONE: Record<ArrivalRisk['level'], 'success' | 'warning' | 'danger'> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
};
const LEVEL_BAR: Record<ArrivalRisk['level'], string> = {
  LOW: 'bg-emerald-500',
  MEDIUM: 'bg-amber-500',
  HIGH: 'bg-red-600',
};

/**
 * Arrivals for the front desk and the duty manager (BUILD_PLAN 8.4): today's or tomorrow's expected guests, the riskiest
 * first, each with the reasons its room may not be ready in time. The score comes from fixed rules, not from AI.
 */
export function ArrivalsApp() {
  const t = useTranslations('staff.arrivals');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const { properties, propertyId, setPropertyId, failed } = usePropertiesWith('hk.arrivals.read');
  const { show: showBrand } = useStaffBrand();
  const [day, setDay] = useState<Day>('today');
  const [list, setList] = useState<ArrivalRisk[] | null>(null);
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
  useEffect(() => {
    if (!propertyId) return;
    setList(null);
    session
      .api<{ arrivals: ArrivalRisk[] }>(
        `/properties/${propertyId}/housekeeping/arrival-risk?day=${day}`,
      )
      .then((r) => setList(r.arrivals))
      .catch(fail);
  }, [session, propertyId, day, fail]);

  if (session.state !== 'signed-in') return <Header />;
  const atRisk = list?.filter((a) => a.level !== 'LOW').length ?? 0;
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
          {(['today', 'tomorrow'] as const).map((x) => (
            <button
              key={x}
              role="tab"
              aria-selected={day === x}
              onClick={() => setDay(x)}
              className={cx(
                'rounded-full px-3 py-1 text-sm font-semibold',
                day === x ? 'bg-brand-soft text-brand' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {t(`day.${x}`)}
            </button>
          ))}
        </div>
        {list && (
          <span className="ms-auto text-slate-600" data-testid="summary">
            {t('summary', { total: list.length, atRisk })}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      ) : (
        <main className="flex flex-col gap-3 p-4">
          <p className="text-xs text-slate-500">{t('rules_note')}</p>
          {list && list.length === 0 && <p className="text-sm text-slate-500">{t('none')}</p>}
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list?.map((a) => (
              <li
                key={a.stayId}
                data-stay={a.stayId}
                data-level={a.level}
                className="relative flex flex-col gap-2 overflow-hidden rounded-2xl bg-white p-4 ps-5 shadow-sm ring-1 ring-slate-900/5"
              >
                <span
                  aria-hidden
                  className={cx('absolute inset-y-0 start-0 w-1.5', LEVEL_BAR[a.level])}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{a.guestName ?? t('guest')}</span>
                  {a.vip && <Badge tone="info">{t('vip')}</Badge>}
                  <span className="ms-auto">
                    <Badge tone={LEVEL_TONE[a.level]}>
                      {t(`level.${a.level}`)} · {a.score}
                    </Badge>
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                  <span>{a.roomNumber ? t('room', { room: a.roomNumber }) : t('no_room')}</span>
                  <span>
                    {a.eta
                      ? t('eta', { time: format.dateTime(new Date(a.eta), { timeStyle: 'short' }) })
                      : t('no_eta')}
                  </span>
                  {a.ready && <span className="font-semibold text-emerald-700">{t('ready')}</span>}
                </div>
                {a.reasons.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label={t('reasons')}>
                    {a.reasons.map((r) => (
                      <li
                        key={r}
                        className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700"
                      >
                        {t(`reason.${r}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </main>
      )}
    </>
  );
}
