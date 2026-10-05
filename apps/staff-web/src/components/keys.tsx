'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { AccessGrant, AccessKind, RoomRow, RoomStay } from '../lib/types';

const TONE: Record<AccessGrant['status'], 'neutral' | 'success' | 'warning' | 'danger'> = {
  REQUESTED: 'warning',
  ISSUED: 'success',
  FAILED: 'danger',
  REVOKE_REQUESTED: 'warning',
  REVOKED: 'neutral',
};
const LIVE: ReadonlyArray<AccessGrant['status']> = ['REQUESTED', 'ISSUED'];

/**
 * Room keys and Wi-Fi at the front desk (BUILD_PLAN 13.3): find the room, see the guest checked in there, issue a
 * key or Wi-Fi from the hotel's own lock and Wi-Fi systems, revoke a lost card. Check-out revokes everything by itself.
 */
export function KeysApp() {
  const t = useTranslations('staff.keys');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } = usePropertiesWith('access.read');
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
  const held = me && propertyId ? permissionsAt(me, propertyId) : new Set<string>();
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
        <Desk
          propertyId={propertyId}
          canKey={held.has('access.key.issue')}
          canWifi={held.has('access.wifi.issue')}
          onError={(e) => {
            setError(null);
            fail(e);
          }}
          onClear={() => setError(null)}
        />
      ) : null}
    </>
  );
}

function Desk({
  propertyId,
  canKey,
  canWifi,
  onError,
  onClear,
}: {
  readonly propertyId: string;
  readonly canKey: boolean;
  readonly canWifi: boolean;
  readonly onError: (e: unknown) => void;
  readonly onClear: () => void;
}) {
  const t = useTranslations('staff.keys');
  const format = useFormatter();
  const session = useSession();
  const base = `/properties/${propertyId}`;
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [number, setNumber] = useState('');
  const [stay, setStay] = useState<RoomStay | null | 'none'>(null);
  const [access, setAccess] = useState<{ available: AccessKind[]; grants: AccessGrant[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    session.api<RoomRow[]>(`${base}/rooms`).then(setRooms).catch(onError);
  }, [session, base, onError]);

  const load = useCallback(
    (stayId: string) =>
      session
        .api<{ available: AccessKind[]; grants: AccessGrant[] }>(`${base}/stays/${stayId}/access`)
        .then(setAccess)
        .catch(onError),
    [session, base, onError],
  );

  async function find(e: React.FormEvent) {
    e.preventDefault();
    onClear();
    setAccess(null);
    const room = rooms.find((r) => r.roomNumber === number.trim());
    if (!room) return setStay('none');
    try {
      const found = await session.api<RoomStay>(`${base}/rooms/${room.locationId}/current-stay`);
      setStay(found);
      await load(found.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setStay('none');
      else onError(err);
    }
  }

  async function act(path: string, body?: unknown) {
    if (!stay || stay === 'none') return;
    setBusy(true);
    try {
      await session.api(`${base}/stays/${stay.id}/access${path}`, {
        method: 'POST',
        ...(body ? { body } : {}),
      });
      await load(stay.id);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const may = (kind: AccessKind) => (kind === 'WIFI' ? canWifi : canKey);
  return (
    <main className="flex max-w-3xl flex-col gap-4 p-4">
      <form onSubmit={(e) => void find(e)} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('room')}</span>
          <input
            className="w-32 rounded-lg border border-slate-300 px-3 py-1.5"
            value={number}
            inputMode="numeric"
            onChange={(e) => setNumber(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={!number.trim()}>
          {t('find')}
        </Button>
      </form>
      {stay === 'none' && <p className="text-sm text-slate-600">{t('nobody')}</p>}
      {stay && stay !== 'none' && (
        <section
          aria-label={t('stay')}
          className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5"
        >
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-lg font-bold">
              {stay.primaryGuest
                ? [stay.primaryGuest.givenName, stay.primaryGuest.familyName]
                    .filter(Boolean)
                    .join(' ')
                : t('guest')}
            </span>
            <span className="text-sm text-slate-500">
              {t('room_until', {
                room: stay.room.roomNumber,
                date: format.dateTime(new Date(`${stay.expectedDeparture}T12:00:00`), {
                  dateStyle: 'medium',
                }),
              })}
            </span>
          </div>
          {access && (
            <>
              <div className="flex flex-wrap gap-2">
                {(['KEY', 'MOBILE_KEY', 'WIFI'] as const)
                  .filter((k) => access.available.includes(k) && may(k))
                  .map((k) => (
                    <Button
                      key={k}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void act('', { kind: k })}
                    >
                      {t(`issue.${k}`)}
                    </Button>
                  ))}
                {access.available.length === 0 && (
                  <p className="text-sm text-slate-500">{t('no_system')}</p>
                )}
              </div>
              {access.grants.length === 0 ? (
                <p className="text-sm text-slate-500">{t('none_yet')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-slate-100">
                  {[...access.grants].reverse().map((g) => (
                    <li
                      key={g.id}
                      data-grant={g.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                    >
                      <span className="font-medium">{t(`kind.${g.kind}`)}</span>
                      {g.roomNumber && <span className="text-slate-500">{g.roomNumber}</span>}
                      <Badge tone={TONE[g.status]}>{t(`status.${g.status}`)}</Badge>
                      {g.revokeReason && (
                        <span className="text-xs text-slate-500">
                          {t(`reason.${g.revokeReason}`)}
                        </span>
                      )}
                      {LIVE.includes(g.status) && may(g.kind) && (
                        <span className="ms-auto">
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void act(`/${g.id}/revoke`)}
                          >
                            {t('revoke')}
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-slate-500">{t('checkout_note')}</p>
            </>
          )}
        </section>
      )}
    </main>
  );
}
