'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type {
  AssignmentPlan,
  Attendant,
  BoardRoom,
  HousekeepingJob,
  HousekeepingState,
  Me,
  PropertySummary,
} from '../lib/types';

type Tab = 'mine' | 'rooms' | 'jobs';

const STATE_TONE: Record<HousekeepingState, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> =
  {
    DIRTY: 'danger',
    PICKUP: 'warning',
    CLEANING: 'info',
    CLEAN: 'success',
    INSPECTING: 'warning',
    INSPECTED: 'success',
  };

/** The floor a room is on: its label, else the room number without the last two digits. */
function floorOf(roomNumber: string, label: string | null): string {
  return label ?? (roomNumber.length > 2 ? roomNumber.slice(0, -2) : '0');
}

function permissionsAt(me: Me, propertyId: string): Set<string> {
  return new Set(
    me.memberships
      .filter((m) => m.propertyId === null || m.propertyId === propertyId)
      .flatMap((m) => m.permissions),
  );
}

/**
 * Housekeeping for staff (Spec §9, BUILD_PLAN 7.4): the attendant's own rooms with one-tap start and done, the room
 * board by floor (state, readiness, guest signals) and, for supervisors, the day's jobs with inspection and a balanced
 * assignment proposal they review before applying. Logical properties only, so the screen mirrors in Arabic.
 */
export function HousekeepingApp() {
  const t = useTranslations('staff.hk');
  const tStaff = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [properties, setProperties] = useState<PropertySummary[] | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('mine');
  const [rooms, setRooms] = useState<BoardRoom[]>([]);
  const [jobs, setJobs] = useState<HousekeepingJob[]>([]);
  const [attendants, setAttendants] = useState<Attendant[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [plan, setPlan] = useState<AssignmentPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  // The header wears the brand of the hotel this screen works on.
  const { show: showBrand } = useStaffBrand();
  useEffect(() => showBrand(propertyId), [propertyId, showBrand]);

  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );

  useEffect(() => {
    if (session.state !== 'signed-in') return;
    void (async () => {
      try {
        const who = await session.api<Me>('/me');
        const all = await session.api<PropertySummary[]>('/properties');
        const allowed = all.filter((p) => permissionsAt(who, p.id).has('hk.board.read'));
        setMe(who);
        setProperties(allowed);
        setPropertyId((current) => current ?? allowed[0]?.id ?? null);
      } catch (e) {
        fail(e);
      }
    })();
  }, [session, fail]);

  const can = useMemo(() => {
    const perms = me && propertyId ? permissionsAt(me, propertyId) : new Set<string>();
    return { plan: perms.has('hk.job.manage'), inspect: perms.has('hk.inspect') };
  }, [me, propertyId]);

  const load = useCallback(async () => {
    if (!propertyId) return;
    const base = `/properties/${propertyId}/housekeeping`;
    const [board, list] = await Promise.all([
      session.api<BoardRoom[]>(`${base}/rooms`),
      session.api<HousekeepingJob[]>(`${base}/jobs`),
    ]);
    setRooms(board);
    setJobs(list);
  }, [session, propertyId]);

  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);
  useEffect(() => {
    if (!propertyId || !can.plan) return;
    session
      .api<Attendant[]>(`/properties/${propertyId}/housekeeping/attendants`)
      .then(setAttendants)
      .catch(fail);
  }, [session, propertyId, can.plan, fail]);

  async function run(action: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      if (done) setNotice(done);
    } catch (e) {
      fail(e);
    }
  }
  const post = (path: string, body: unknown = {}) =>
    session.api(`/properties/${propertyId}${path}`, { method: 'POST', body });

  const names = useMemo(() => new Map(attendants.map((a) => [a.id, a.displayName])), [attendants]);
  const stateOf = useMemo(() => new Map(rooms.map((r) => [r.roomId, r])), [rooms]);
  const mine = jobs.filter(
    (j) =>
      j.assignee?.type === 'USER' &&
      j.assignee.id === me?.user.id &&
      (j.status === 'OPEN' || j.status === 'IN_PROGRESS'),
  );
  const floors = useMemo(() => {
    const byFloor = new Map<string, BoardRoom[]>();
    for (const r of rooms) {
      const f = floorOf(r.roomNumber, r.floorLabel);
      byFloor.set(f, [...(byFloor.get(f) ?? []), r]);
    }
    return [...byFloor.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  }, [rooms]);

  const jobLabel = (j: HousekeepingJob) => t(`type.${j.cleaningType}`);
  const flags = (j: HousekeepingJob) => (
    <>
      {j.makeUpRequested && <Badge tone="warning">{t('signal.MAKE_UP_ROOM')}</Badge>}
      {j.doNotDisturb && <Badge tone="danger">{t('signal.DND')}</Badge>}
    </>
  );

  if (session.state !== 'signed-in') return <Header />;
  return (
    <>
      <Header />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 text-sm">
        <h1 className="font-semibold">{t('title')}</h1>
        {properties && properties.length > 1 && (
          <select
            aria-label={tStaff('inbox.property')}
            className="rounded border border-slate-300 px-2 py-1"
            value={propertyId ?? ''}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setPlan(null);
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
          {(['mine', 'rooms', 'jobs'] as const).map((x) => (
            <button
              key={x}
              role="tab"
              aria-selected={tab === x}
              onClick={() => setTab(x)}
              className={cx(
                'rounded px-2 py-1 text-xs',
                tab === x ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
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
      ) : (
        <main className="flex flex-col gap-4 p-4">
          {tab === 'mine' && (
            <section aria-labelledby="mine-title" className="flex flex-col gap-2">
              <h2 id="mine-title" className="text-sm font-semibold text-slate-600">
                {t('mine_title')}
              </h2>
              {mine.length === 0 && <p className="text-sm text-slate-500">{t('mine_empty')}</p>}
              <ul className="flex flex-col gap-2">
                {mine.map((j) => (
                  <li
                    key={j.id}
                    data-job={j.roomNumber}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 shadow-sm"
                  >
                    <span className="text-lg font-semibold">{j.roomNumber}</span>
                    <span className="text-sm text-slate-600">{jobLabel(j)}</span>
                    {flags(j)}
                    <span className="ms-auto flex gap-2">
                      {j.status === 'OPEN' && (
                        <Button onClick={() => run(() => post(`/tasks/${j.taskId}/start`))}>
                          {t('start')}
                        </Button>
                      )}
                      {j.status === 'IN_PROGRESS' && (
                        <Button
                          onClick={() =>
                            run(() => post(`/tasks/${j.taskId}/complete`), t('done_notice'))
                          }
                        >
                          {t('done')}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === 'rooms' &&
            floors.map(([floor, list]) => (
              <section
                key={floor}
                aria-labelledby={`floor-${floor}`}
                className="flex flex-col gap-2"
              >
                <h2 id={`floor-${floor}`} className="text-sm font-semibold text-slate-600">
                  {t('floor', { floor })}
                </h2>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {list.map((r) => (
                    <li
                      key={r.roomId}
                      data-room={r.roomNumber}
                      className="flex flex-col gap-1 rounded-lg bg-white p-2 text-sm shadow-sm"
                    >
                      <span className="flex items-center gap-1">
                        <span className="font-semibold">{r.roomNumber}</span>
                        {r.ready && (
                          <span className="ms-auto">
                            <Badge tone="success">{t('ready')}</Badge>
                          </span>
                        )}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {r.housekeeping && (
                          <Badge tone={STATE_TONE[r.housekeeping]}>
                            {t(`state.${r.housekeeping}`)}
                          </Badge>
                        )}
                        {r.occupancy && (
                          <span className="text-xs text-slate-500">
                            {t(`occupancy.${r.occupancy}`)}
                          </span>
                        )}
                      </span>
                      {r.frontOffice && <Badge tone="danger">{t('out_of_order')}</Badge>}
                      {r.signals.map((s) => (
                        <Badge key={s.signal} tone={s.signal === 'DND' ? 'danger' : 'warning'}>
                          {t(`signal.${s.signal}`)}
                        </Badge>
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
            ))}

          {tab === 'jobs' && (
            <>
              <section aria-labelledby="jobs-title" className="flex flex-col gap-2">
                <h2 id="jobs-title" className="text-sm font-semibold text-slate-600">
                  {t('jobs_title', {
                    credits: format.number(jobs.reduce((s, j) => s + j.credits, 0)),
                  })}
                </h2>
                {jobs.length === 0 && <p className="text-sm text-slate-500">{t('jobs_empty')}</p>}
                <ul className="flex flex-col gap-1">
                  {jobs.map((j) => {
                    const awaiting =
                      j.status === 'DONE' && stateOf.get(j.roomId)?.housekeeping === 'INSPECTING';
                    return (
                      <li
                        key={j.id}
                        data-job={j.roomNumber}
                        className="flex flex-wrap items-center gap-2 rounded bg-white px-3 py-2 text-sm shadow-sm"
                      >
                        <span className="w-12 font-semibold">{j.roomNumber}</span>
                        <span>{jobLabel(j)}</span>
                        <span className="text-xs text-slate-500">
                          {t('credits', { credits: format.number(j.credits) })}
                        </span>
                        <Badge tone="neutral">{t(`job_status.${j.status}`)}</Badge>
                        {flags(j)}
                        <span className="text-xs text-slate-600">
                          {j.assignee?.type === 'USER'
                            ? (names.get(j.assignee.id) ?? t('assigned'))
                            : t('unassigned')}
                        </span>
                        {awaiting && can.inspect && (
                          <span className="ms-auto flex gap-2">
                            <Button
                              variant="secondary"
                              onClick={() =>
                                run(() =>
                                  post(`/housekeeping/jobs/${j.id}/inspection`, { result: 'PASS' }),
                                )
                              }
                            >
                              {t('inspect_pass')}
                            </Button>
                            <Button
                              variant="danger"
                              onClick={() =>
                                run(() =>
                                  post(`/housekeeping/jobs/${j.id}/inspection`, { result: 'FAIL' }),
                                )
                              }
                            >
                              {t('inspect_fail')}
                            </Button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {can.plan && (
                <section
                  aria-labelledby="plan-title"
                  className="flex flex-col gap-2 rounded-lg bg-white p-3 shadow-sm"
                >
                  <h2 id="plan-title" className="text-sm font-semibold text-slate-600">
                    {t('plan_title')}
                  </h2>
                  {attendants.length === 0 && (
                    <p className="text-sm text-slate-500">{t('no_attendants')}</p>
                  )}
                  <fieldset className="flex flex-wrap gap-3">
                    <legend className="sr-only">{t('plan_attendants')}</legend>
                    {attendants.map((a) => (
                      <label key={a.id} className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={chosen.includes(a.id)}
                          onChange={(e) =>
                            setChosen((c) =>
                              e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id),
                            )
                          }
                        />
                        {a.displayName}
                      </label>
                    ))}
                  </fieldset>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      disabled={chosen.length === 0}
                      onClick={async () => {
                        setError(null);
                        try {
                          setPlan(
                            await session.api<AssignmentPlan>(
                              `/properties/${propertyId}/housekeeping/assignments/proposal`,
                              { method: 'POST', body: { attendantIds: chosen } },
                            ),
                          );
                        } catch (e) {
                          fail(e);
                        }
                      }}
                    >
                      {t('propose')}
                    </Button>
                    {plan && plan.plan.some((p) => p.jobs.length > 0) && (
                      <Button
                        onClick={() =>
                          run(async () => {
                            await post('/housekeeping/assignments', {
                              assignments: plan.plan.flatMap((p) =>
                                p.jobs.map((j) => ({ jobId: j.jobId, userId: p.attendantId })),
                              ),
                            });
                            setPlan(null);
                          }, t('applied'))
                        }
                      >
                        {t('apply')}
                      </Button>
                    )}
                  </div>
                  {plan && (
                    <ul className="flex flex-col gap-1" aria-label={t('plan_title')}>
                      {plan.plan.map((p) => (
                        <li key={p.attendantId} data-attendant={p.attendantId} className="text-sm">
                          <span className="font-medium">{names.get(p.attendantId)}</span>
                          {' · '}
                          {t('credits', { credits: format.number(p.credits) })}
                          {' · '}
                          {p.jobs.map((j) => j.roomNumber).join(', ') || '—'}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </main>
      )}
    </>
  );
}
