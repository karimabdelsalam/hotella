'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  cx,
  DiningIcon,
  HeartIcon,
  KeyIcon,
  PhoneIcon,
  SearchIcon,
} from '@hotella/ui';
import { Header } from './header';
import { panel, STATUS_TONE } from './home';
import { field, label, type Run } from './restaurant-common';
import { RestaurantBooking } from './restaurant-booking';
import { Link, useRouter } from '../i18n/navigation';
import { permissionsAt, useEntitled, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type {
  CatalogService,
  DeskServiceVersion,
  RoomCurrentStay,
  RoomRow,
  ServiceFieldDefinition,
  ServiceRequestRow,
} from '../lib/types';

type Tool = 'request' | 'restaurant';
type FieldLabels = Record<string, { label?: string; options?: Record<string, string> }>;

/** A published service as the desk offers it: its name and field labels in the screen's language. */
interface DeskService {
  readonly code: string;
  readonly name: string;
  readonly fields: readonly ServiceFieldDefinition[];
  readonly labels: FieldLabels;
  readonly scheduling: boolean;
}

function deskServices(all: readonly CatalogService[], locale: string): DeskService[] {
  return all
    .filter((s) => s.status === 'ACTIVE' && s.published)
    .map((s) => {
      const v = s.published as DeskServiceVersion;
      const t =
        v.translations.find((x) => x.locale === locale) ??
        v.translations.find((x) => x.locale === 'en') ??
        v.translations[0];
      return {
        code: s.code,
        name: t?.name ?? s.code,
        fields: v.requiredFields ?? [],
        labels: ((t?.fieldLabels as FieldLabels | undefined) ?? {}) satisfies FieldLabels,
        scheduling: v.availability?.allowScheduling === true,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}

/**
 * The front desk (BUILD_PLAN S.1): find a room, see who is staying, and act for the guest on the phone or at the
 * desk — ask for a service (the same entrypoint and rules as the guest app, source STAFF), book a restaurant, follow
 * and cancel the stay's requests, and go on to keys or a complaint. The PMS stays the source of the stay (rule 19).
 */
export function FrontDeskApp() {
  const t = useTranslations('staff.desk');
  const tStaff = useTranslations('staff');
  const locale = useLocale();
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const entitled = useEntitled();
  const { me, properties, propertyId, setPropertyId, failed } = usePropertiesWith('stay.read');
  const { show: showBrand } = useStaffBrand();
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [services, setServices] = useState<DeskService[]>([]);
  const [number, setNumber] = useState('');
  const [found, setFound] = useState<RoomCurrentStay | 'no-room' | 'no-stay' | null>(null);
  const [requests, setRequests] = useState<ServiceRequestRow[] | null>(null);
  const [tool, setTool] = useState<Tool>(
    params.get('do') === 'restaurant' ? 'restaurant' : 'request',
  );
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

  const held = useMemo(
    () => (me && propertyId ? permissionsAt(me, propertyId) : new Set<string>()),
    [me, propertyId],
  );
  const can = {
    request: held.has('request.create') && held.has('catalog.read') && entitled('GUEST_EXPERIENCE'),
    follow: held.has('request.read') && entitled('GUEST_EXPERIENCE'),
    cancel: held.has('request.manage'),
    restaurant: held.has('restaurant.reservation.manage') && entitled('RESTAURANT'),
    override: held.has('restaurant.reservation.override'),
    keys: held.has('access.read'),
    complaint: held.has('complaint.manage') && entitled('GUEST_RELATIONS'),
  };
  const tools = (['request', 'restaurant'] as const).filter((k) => can[k]);
  const currentTool = tools.includes(tool) ? tool : (tools[0] ?? null);
  const base = propertyId ? `/properties/${propertyId}` : null;

  useEffect(() => {
    if (!base) return;
    let live = true;
    session
      .api<RoomRow[]>(`${base}/rooms`)
      .then((r) => live && setRooms(r))
      .catch(fail);
    return () => {
      live = false;
    };
  }, [session, base, fail]);
  const canRequest = can.request;
  useEffect(() => {
    if (!propertyId || !canRequest) return;
    let live = true;
    session
      .api<CatalogService[]>(`/catalog/services?propertyId=${propertyId}`)
      .then((all) => live && setServices(deskServices(all, locale)))
      .catch(fail);
    return () => {
      live = false;
    };
  }, [session, propertyId, canRequest, locale, fail]);

  const stay = found && typeof found === 'object' ? found : null;
  const stayId = stay?.id ?? null;
  const canFollow = can.follow;
  const loadRequests = useCallback(async () => {
    if (!base || !stayId || !canFollow) return setRequests(null);
    setRequests(
      await session.api<ServiceRequestRow[]>(
        `${base}/service-requests?stayId=${stayId}&status=OPEN,IN_PROGRESS,COMPLETED,CANCELLED&limit=20`,
      ),
    );
  }, [session, base, stayId, canFollow]);
  useEffect(() => {
    loadRequests().catch(fail);
  }, [loadRequests, fail]);

  const find = useCallback(
    async (wanted: string) => {
      const value = wanted.trim();
      if (!base || !rooms || !value) return;
      setError(null);
      setNotice(null);
      setRequests(null);
      const room = rooms.find((r) => r.roomNumber.toLowerCase() === value.toLowerCase());
      if (!room) return setFound('no-room');
      try {
        setFound(
          await session.api<RoomCurrentStay>(`${base}/rooms/${room.locationId}/current-stay`),
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setFound('no-stay');
        else fail(e);
      }
    },
    [session, base, rooms, fail],
  );

  // The top bar's search (and links from the home page) bring the room in the address.
  const asked = params.get('room');
  useEffect(() => {
    if (!asked) return;
    setNumber(asked);
    void find(asked);
  }, [asked, find]);

  const run: Run = async (action, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (session.state !== 'signed-in') return <Header />;
  const guestName = stay?.primaryGuest
    ? [stay.primaryGuest.givenName, stay.primaryGuest.familyName].filter(Boolean).join(' ')
    : t('guest');

  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
            <p className="text-sm text-slate-500">{t('subtitle')}</p>
          </div>
          {properties && properties.length > 1 && (
            <select
              aria-label={tStaff('inbox.property')}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
              value={propertyId ?? ''}
              onChange={(e) => {
                setFound(null);
                setRooms(null);
                setPropertyId(e.target.value);
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

        {properties && properties.length === 0 && (
          <p className={cx(panel, 'p-6 text-sm text-slate-600')}>{t('no_property')}</p>
        )}

        {base && (
          <form
            className={cx(panel, 'flex flex-wrap items-end gap-3 p-4')}
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void find(number);
            }}
          >
            <label className={cx(label, 'min-w-40 flex-1')}>
              {t('room')}
              <input
                className={cx(field, 'text-base')}
                inputMode="text"
                autoComplete="off"
                placeholder={t('room_placeholder')}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={!rooms || !number.trim()} className="h-10">
              <SearchIcon className="size-4" />
              {t('find')}
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-xl bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        )}
        {found === 'no-room' && (
          <p className={cx(panel, 'p-4 text-sm text-slate-600')}>
            {t('no_room', { room: number.trim() })}
          </p>
        )}
        {found === 'no-stay' && (
          <p className={cx(panel, 'p-4 text-sm text-slate-600')}>
            {t('no_stay', { room: number.trim() })}
          </p>
        )}

        {stay && base && (
          <>
            <div
              className={cx(panel, 'flex flex-wrap items-center gap-4 p-4')}
              data-testid="stay-card"
            >
              <span className="flex size-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-slate-900 text-white">
                <span className="text-[10px] font-semibold opacity-70">{t('room_short')}</span>
                <span className="text-lg leading-none font-bold">{stay.room.roomNumber}</span>
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-bold">{guestName}</span>
                  <Badge tone={stay.status === 'IN_HOUSE' ? 'success' : 'info'}>
                    {t(`stay_status.${stay.status}`)}
                  </Badge>
                  {stay.primaryGuest?.vipCode && <Badge tone="info">{tStaff('home.vip')}</Badge>}
                </span>
                <span className="text-sm text-slate-600">
                  {format.dateTime(new Date(`${stay.expectedArrival}T12:00:00Z`), {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  })}{' '}
                  –{' '}
                  {format.dateTime(new Date(`${stay.expectedDeparture}T12:00:00Z`), {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  })}{' '}
                  · {tStaff('home.party', { count: stay.adults + stay.children })}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {can.keys && (
                  <Link
                    href="/keys"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                  >
                    <KeyIcon className="size-4 text-slate-500" />
                    {t('to_keys')}
                  </Link>
                )}
                {can.complaint && (
                  <Link
                    href="/relations"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                  >
                    <HeartIcon className="size-4 text-slate-500" />
                    {t('to_complaint')}
                  </Link>
                )}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-3">
                {tools.length > 1 && (
                  <div
                    role="tablist"
                    aria-label={t('for_guest')}
                    className="flex gap-1 rounded-xl bg-slate-200/60 p-1"
                  >
                    {tools.map((k) => {
                      const Icon = k === 'request' ? PhoneIcon : DiningIcon;
                      return (
                        <button
                          key={k}
                          type="button"
                          role="tab"
                          aria-selected={currentTool === k}
                          onClick={() => setTool(k)}
                          className={cx(
                            'flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition',
                            currentTool === k
                              ? 'bg-white shadow-sm'
                              : 'text-slate-600 hover:text-slate-900',
                          )}
                        >
                          <Icon className="size-4" />
                          {t(`tool_${k}`)}
                        </button>
                      );
                    })}
                  </div>
                )}
                {currentTool === 'request' && (
                  <RequestForm
                    key={stay.id}
                    base={base}
                    stayId={stay.id}
                    room={stay.room.roomNumber}
                    services={services}
                    busy={busy}
                    run={run}
                    onSent={(message) => {
                      setNotice(message);
                      void loadRequests().catch(fail);
                    }}
                  />
                )}
                {currentTool === 'restaurant' && (
                  <RestaurantBooking
                    base={base}
                    canOverride={can.override}
                    busy={busy}
                    run={run}
                    room={stay.room.roomNumber}
                    onBooked={() => undefined}
                  />
                )}
              </div>
              {can.follow && (
                <StayRequests
                  base={base}
                  requests={requests}
                  canCancel={can.cancel}
                  busy={busy}
                  run={run}
                  onChanged={() => void loadRequests().catch(fail)}
                />
              )}
            </div>
          </>
        )}
      </main>
    </>
  );
}

function RequestForm({
  base,
  stayId,
  room,
  services,
  busy,
  run,
  onSent,
}: {
  readonly base: string;
  readonly stayId: string;
  readonly room: string;
  readonly services: readonly DeskService[];
  readonly busy: boolean;
  readonly run: Run;
  readonly onSent: (message: string) => void;
}) {
  const t = useTranslations('staff.desk');
  const [code, setCode] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [when, setWhen] = useState('');
  const session = useSession();
  const service = services.find((s) => s.code === code) ?? null;
  const missing = service
    ? service.fields.some(
        (f) => f.required && f.type !== 'BOOLEAN' && !String(values[f.code] ?? '').trim(),
      )
    : true;

  async function send() {
    if (!service) return;
    const fields: Record<string, unknown> = {};
    for (const f of service.fields) {
      const v = values[f.code];
      if (v === undefined || v === '') continue;
      if (f.type === 'NUMBER') fields[f.code] = Number(v);
      else if (f.type === 'BOOLEAN') fields[f.code] = v === true;
      else if (f.type === 'DATETIME') fields[f.code] = new Date(String(v)).toISOString();
      else fields[f.code] = v;
    }
    let related = false;
    const ok = await run(async () => {
      const created = await session.api<{ related: boolean }>(
        `${base}/stays/${stayId}/service-requests`,
        {
          method: 'POST',
          body: {
            serviceCode: service.code,
            fields,
            ...(service.scheduling && when ? { requestedForAt: new Date(when).toISOString() } : {}),
          },
        },
      );
      related = created.related;
    });
    if (!ok) return;
    setCode('');
    setValues({});
    setWhen('');
    onSent(
      related
        ? t('sent_related', { service: service.name, room })
        : t('sent', { service: service.name, room }),
    );
  }

  return (
    <div
      className={cx(panel, 'flex flex-col gap-4 p-4')}
      role="region"
      aria-label={t('tool_request')}
    >
      <div>
        <h2 className="font-bold">{t('request_title', { room })}</h2>
        <p className="text-sm text-slate-500">{t('request_hint')}</p>
      </div>
      {services.length === 0 && <p className="text-sm text-slate-500">{t('no_services')}</p>}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('service')}>
        {services.map((s) => (
          <button
            key={s.code}
            type="button"
            aria-pressed={code === s.code}
            onClick={() => {
              setCode(s.code);
              setValues({});
            }}
            className={cx(
              'rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition',
              code === s.code
                ? 'bg-slate-900 text-white ring-transparent'
                : 'bg-white text-slate-700 ring-slate-200 hover:ring-slate-400',
            )}
          >
            {s.name}
          </button>
        ))}
      </div>
      {service && (
        <form
          className="flex flex-col gap-3 border-t border-slate-100 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {service.fields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {service.fields.map((f) => {
                const l = service.labels[f.code];
                const text = `${l?.label ?? f.code}${f.required ? ' *' : ''}`;
                const value = values[f.code];
                const set = (v: string | boolean) => setValues((all) => ({ ...all, [f.code]: v }));
                if (f.type === 'BOOLEAN')
                  return (
                    <label key={f.code} className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(e) => set(e.target.checked)}
                      />
                      {text}
                    </label>
                  );
                return (
                  <label key={f.code} className={label}>
                    {text}
                    {f.type === 'CHOICE' ? (
                      <select
                        className={field}
                        value={String(value ?? '')}
                        onChange={(e) => set(e.target.value)}
                      >
                        <option value="">{t('choose')}</option>
                        {f.options.map((o) => (
                          <option key={o} value={o}>
                            {l?.options?.[o] ?? o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={field}
                        type={
                          f.type === 'NUMBER'
                            ? 'number'
                            : f.type === 'DATETIME'
                              ? 'datetime-local'
                              : 'text'
                        }
                        {...(f.type === 'NUMBER' ? { min: f.min ?? 1, max: f.max ?? 10 } : {})}
                        {...(f.type === 'TEXT' ? { maxLength: f.maxLength ?? 500 } : {})}
                        value={String(value ?? '')}
                        onChange={(e) => set(e.target.value)}
                      />
                    )}
                  </label>
                );
              })}
            </div>
          )}
          {service.scheduling && (
            <label className={cx(label, 'sm:w-1/2')}>
              {t('when')}
              <input
                type="datetime-local"
                className={field}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </label>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy || missing}>
              {t('send_request', { service: service.name })}
            </Button>
            <span className="text-xs text-slate-500">{t('source_note')}</span>
          </div>
        </form>
      )}
    </div>
  );
}

function StayRequests({
  base,
  requests,
  canCancel,
  busy,
  run,
  onChanged,
}: {
  readonly base: string;
  readonly requests: ServiceRequestRow[] | null;
  readonly canCancel: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('staff.desk');
  const format = useFormatter();
  const session = useSession();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  return (
    <div
      className={cx(panel, 'flex flex-col self-start')}
      role="region"
      aria-label={t('stay_requests')}
    >
      <h2 className="border-b border-slate-100 px-4 py-3 font-bold">{t('stay_requests')}</h2>
      {requests && requests.length === 0 && (
        <p className="px-4 py-6 text-sm text-slate-500">{t('no_requests')}</p>
      )}
      <ul className="divide-y divide-slate-100">
        {requests?.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 px-4 py-3" data-request={r.serviceCode}>
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-semibold">{r.serviceName}</span>
                <span className="text-xs text-slate-500">
                  {format.relativeTime(new Date(r.createdAt))} ·{' '}
                  {t(`source.${r.source === 'STAFF' ? 'STAFF' : 'GUEST'}`)}
                </span>
              </span>
              <Badge tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
            </div>
            {canCancel &&
              (r.status === 'OPEN' || r.status === 'IN_PROGRESS') &&
              cancelling !== r.id && (
                <button
                  type="button"
                  className="self-start text-xs font-semibold text-red-700 hover:underline"
                  onClick={() => {
                    setCancelling(r.id);
                    setReason('');
                  }}
                >
                  {t('cancel')}
                </button>
              )}
            {cancelling === r.id && (
              <form
                className="flex flex-col gap-2 rounded-xl bg-red-50 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    async () => {
                      await session.api(`${base}/service-requests/${r.id}/cancel`, {
                        method: 'POST',
                        body: reason.trim() ? { reason: reason.trim() } : {},
                      });
                      setCancelling(null);
                      onChanged();
                    },
                    t('cancelled', { service: r.serviceName }),
                  );
                }}
              >
                <label className={label}>
                  {t('cancel_reason')}
                  <input
                    className={field}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <div className="flex gap-2">
                  <Button type="submit" variant="danger" disabled={busy}>
                    {t('confirm_cancel')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setCancelling(null)}>
                    {t('keep')}
                  </Button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
