'use client';

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx, LOCALE_NAMES, LOCALES } from '@hotella/ui';
import { Header } from './header';
import { card, field, label, type Run } from './restaurant-common';
import { useRouter } from '../i18n/navigation';
import { holdsAnywhere, permissionsAt, useMe } from '../lib/access';
import { ApiError, useSession } from '../lib/session';
import type {
  Invitation,
  PropertySummary,
  RoleSummary,
  StaffMembership,
  StaffUser,
  StaffUserDetail,
} from '../lib/types';

const STATUS_TONE = { ACTIVE: 'success', INVITED: 'info', DISABLED: 'neutral' } as const;
const ALL = '';

/**
 * The hotel's staff (BUILD_PLAN pilot P.3): who has an account, invite someone with a role at a property (or every
 * property), change their roles, take a role away, disable or re-enable an account. The invitation link is shown
 * once to the person who invites; it carries the hotel code and goes to the invitee by the hotel's own means. Every
 * action is checked by the API (memberships, ActionGate, audit); the screen only hides what the person cannot do.
 */
export function StaffAdminApp() {
  const t = useTranslations('staff.people');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const me = useMe();
  const tenantId = me?.user.tenantId ?? null;
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [properties, setProperties] = useState<PropertySummary[]>([]);
  const [selected, setSelected] = useState<StaffUserDetail | null>(null);
  const [invited, setInvited] = useState<Invitation | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );
  const can = useMemo(
    () => ({
      manage: !!me && holdsAnywhere(me, 'iam.user.manage'),
      memberships: !!me && holdsAnywhere(me, 'iam.membership.manage'),
      tenantWide: !!me && permissionsAt(me, null).has('iam.membership.manage'),
    }),
    [me],
  );
  const base = tenantId ? `/tenants/${tenantId}` : null;

  const load = useCallback(async () => {
    if (!base) return;
    const [u, r, p] = await Promise.all([
      session.api<StaffUser[]>(`${base}/users`),
      session.api<RoleSummary[]>(`${base}/roles`),
      session.api<PropertySummary[]>('/properties'),
    ]);
    setUsers(u);
    setRoles(r);
    setProperties(p);
  }, [session, base]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  const open = useCallback(
    async (id: string) => setSelected(await session.api<StaffUserDetail>(`${base}/users/${id}`)),
    [session, base],
  );

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

  const shown = (users ?? []).filter((u) =>
    `${u.givenName} ${u.familyName ?? ''} ${u.email}`.toLowerCase().includes(query.toLowerCase()),
  );
  const propertyName = (id: string | null) =>
    id === null ? t('all_properties') : (properties.find((p) => p.id === id)?.name ?? id);

  if (session.state !== 'signed-in') return <Header />;
  return (
    <>
      <Header />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 text-sm">
        <h1 className="text-base font-bold">{t('title')}</h1>
        <input
          type="search"
          aria-label={t('search')}
          placeholder={t('search')}
          className={cx(field, 'ms-auto w-56')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
      {me && !tenantId && <p className="p-6 text-sm text-slate-600">{t('no_hotel')}</p>}
      <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <section className={card} aria-labelledby="people-list">
          <h2 id="people-list" className="mb-3 font-semibold">
            {t('list', { count: shown.length })}
          </h2>
          <ul className="divide-y divide-slate-100">
            {shown.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === u.id}
                  data-user={u.email}
                  onClick={() => void open(u.id).catch(fail)}
                  className={cx(
                    'flex w-full flex-wrap items-center gap-2 px-2 py-2.5 text-start hover:bg-slate-50',
                    selected?.id === u.id && 'bg-brand-soft',
                  )}
                >
                  <span className="font-semibold">
                    {u.givenName} {u.familyName}
                  </span>
                  <span className="text-xs text-slate-500" dir="ltr">
                    {u.email}
                  </span>
                  <span className="ms-auto flex gap-1">
                    {u.mfaEnabled && <Badge tone="info">{t('mfa_on')}</Badge>}
                    <Badge tone={STATUS_TONE[u.status]}>{t(`status.${u.status}`)}</Badge>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {users && shown.length === 0 && <p className="text-sm text-slate-500">{t('none')}</p>}
        </section>
        <div className="flex flex-col gap-4">
          {selected && (
            <UserPanel
              user={selected}
              roles={roles}
              properties={properties}
              propertyName={propertyName}
              can={can}
              self={selected.id === me?.user.id}
              base={base!}
              busy={busy}
              run={run}
              onChanged={async () => {
                await open(selected.id);
                await load();
              }}
            />
          )}
          {can.manage && (
            <InviteForm
              roles={roles}
              properties={properties}
              tenantWide={can.tenantWide}
              base={base}
              busy={busy}
              run={run}
              onInvited={async (inv) => {
                setInvited(inv);
                await load();
              }}
            />
          )}
          {invited && <InvitationLink invitation={invited} onClose={() => setInvited(null)} />}
        </div>
      </main>
    </>
  );
}

function InviteForm({
  roles,
  properties,
  tenantWide,
  base,
  busy,
  run,
  onInvited,
}: {
  readonly roles: readonly RoleSummary[];
  readonly properties: readonly PropertySummary[];
  readonly tenantWide: boolean;
  readonly base: string | null;
  readonly busy: boolean;
  readonly run: Run;
  readonly onInvited: (invitation: Invitation) => Promise<void>;
}) {
  const t = useTranslations('staff.people');
  const locale = useLocale();
  const session = useSession();
  const empty = {
    email: '',
    givenName: '',
    familyName: '',
    localePref: locale,
    role: '',
    scope: '',
  };
  const [form, setForm] = useState(empty);
  const scope = form.scope || (tenantWide ? ALL : (properties[0]?.id ?? ALL));
  return (
    <form
      className={cx(card, 'flex flex-col gap-2')}
      aria-labelledby="invite-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (!base) return;
        void run(async () => {
          const inv = await session.api<Invitation>(`${base}/users`, {
            method: 'POST',
            body: {
              email: form.email.trim(),
              givenName: form.givenName.trim(),
              ...(form.familyName.trim() ? { familyName: form.familyName.trim() } : {}),
              localePref: form.localePref,
              memberships: [
                {
                  propertyId: scope === ALL ? null : scope,
                  roleCodes: [form.role || roles[0]!.code],
                },
              ],
            },
          });
          setForm(empty);
          await onInvited(inv);
        }, t('invited'));
      }}
    >
      <h2 id="invite-title" className="font-semibold">
        {t('invite')}
      </h2>
      <label className={label}>
        {t('email')}
        <input
          type="email"
          required
          dir="ltr"
          className={field}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={label}>
          {t('given_name')}
          <input
            required
            className={field}
            value={form.givenName}
            onChange={(e) => setForm({ ...form, givenName: e.target.value })}
          />
        </label>
        <label className={label}>
          {t('family_name')}
          <input
            className={field}
            value={form.familyName}
            onChange={(e) => setForm({ ...form, familyName: e.target.value })}
          />
        </label>
      </div>
      <label className={label}>
        {t('language')}
        <select
          className={field}
          value={form.localePref}
          onChange={(e) => setForm({ ...form, localePref: e.target.value })}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t('role')}
        <select
          required
          className={field}
          value={form.role || roles[0]?.code || ''}
          onChange={(e) => setForm({ ...form, role: e.target.value })}
        >
          {roles.map((r) => (
            <option key={r.id} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t('where')}
        <select
          className={field}
          value={scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value })}
        >
          {tenantWide && <option value={ALL}>{t('all_properties')}</option>}
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" disabled={busy || roles.length === 0}>
        {t('send_invite')}
      </Button>
    </form>
  );
}

/** The link that sets the password, shown once: the API keeps only its hash. */
function InvitationLink({
  invitation,
  onClose,
}: {
  readonly invitation: Invitation;
  readonly onClose: () => void;
}) {
  const t = useTranslations('staff.people');
  const locale = useLocale();
  const format = useFormatter();
  const [copied, setCopied] = useState(false);
  const fragment = new URLSearchParams({
    token: invitation.invitation.token,
    ...(invitation.invitation.tenantCode ? { hotel: invitation.invitation.tenantCode } : {}),
  });
  const link = `${window.location.origin}/${locale}/invite#${fragment.toString()}`;
  return (
    <section
      className={cx(card, 'flex flex-col gap-2 ring-2 ring-emerald-500')}
      aria-labelledby="link-title"
    >
      <h2 id="link-title" className="font-semibold">
        {t('link_title', { name: invitation.user.givenName })}
      </h2>
      <p className="text-sm text-slate-600">
        {t('link_hint', {
          expires: format.dateTime(new Date(invitation.invitation.expiresAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        })}
      </p>
      <input
        readOnly
        dir="ltr"
        aria-label={t('link')}
        className={cx(field, 'font-mono text-xs')}
        value={link}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="flex gap-2">
        <Button
          onClick={() =>
            void navigator.clipboard
              ?.writeText(link)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? t('copied') : t('copy')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('done')}
        </Button>
      </div>
    </section>
  );
}

function UserPanel({
  user,
  roles,
  properties,
  propertyName,
  can,
  self,
  base,
  busy,
  run,
  onChanged,
}: {
  readonly user: StaffUserDetail;
  readonly roles: readonly RoleSummary[];
  readonly properties: readonly PropertySummary[];
  readonly propertyName: (id: string | null) => string;
  readonly can: { manage: boolean; memberships: boolean; tenantWide: boolean };
  readonly self: boolean;
  readonly base: string;
  readonly busy: boolean;
  readonly run: Run;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslations('staff.people');
  const format = useFormatter();
  const session = useSession();
  const active = user.memberships.filter((m) => m.status === 'ACTIVE');
  const [grant, setGrant] = useState({ scope: '', role: '' });
  const free = [
    ...(can.tenantWide && !active.some((m) => m.propertyId === null) ? [ALL] : []),
    ...properties.filter((p) => !active.some((m) => m.propertyId === p.id)).map((p) => p.id),
  ];
  const scope = free.includes(grant.scope) ? grant.scope : (free[0] ?? null);
  return (
    <section className={cx(card, 'flex flex-col gap-3')} aria-labelledby="person-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="person-title" className="font-semibold">
          {user.givenName} {user.familyName}
        </h2>
        <Badge tone={STATUS_TONE[user.status]}>{t(`status.${user.status}`)}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">{t('email')}</dt>
        <dd dir="ltr" className="text-start">
          {user.email}
        </dd>
        <dt className="text-slate-500">{t('last_login')}</dt>
        <dd>
          {user.lastLoginAt
            ? format.dateTime(new Date(user.lastLoginAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : t('never')}
        </dd>
        <dt className="text-slate-500">{t('mfa')}</dt>
        <dd>{user.mfaEnabled ? t('mfa_on') : t('mfa_off')}</dd>
      </dl>
      <h3 className="text-sm font-semibold">{t('roles')}</h3>
      <ul className="flex flex-col gap-2">
        {active.map((m) => (
          <MembershipRow
            key={m.id}
            membership={m}
            roles={roles}
            where={propertyName(m.propertyId)}
            canEdit={can.memberships && !self}
            base={base}
            busy={busy}
            run={run}
            onChanged={onChanged}
          />
        ))}
        {active.length === 0 && <li className="text-sm text-slate-500">{t('no_roles')}</li>}
      </ul>
      {can.memberships && !self && scope !== null && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('add_role')}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await session.api(`${base}/users/${user.id}/memberships`, {
                method: 'POST',
                body: {
                  propertyId: scope === ALL ? null : scope,
                  roleCodes: [grant.role || roles[0]!.code],
                },
              });
              await onChanged();
            }, t('saved'));
          }}
        >
          <label className={label}>
            {t('where')}
            <select
              className={field}
              value={scope}
              onChange={(e) => setGrant({ ...grant, scope: e.target.value })}
            >
              {free.map((id) => (
                <option key={id} value={id}>
                  {propertyName(id === ALL ? null : id)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('role')}
            <select
              className={field}
              value={grant.role || roles[0]?.code || ''}
              onChange={(e) => setGrant({ ...grant, role: e.target.value })}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.code}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary" disabled={busy}>
            {t('add_role')}
          </Button>
        </form>
      )}
      {can.manage && !self && (
        <div className="border-t border-slate-100 pt-3">
          {user.status === 'DISABLED' ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await session.api(`${base}/users/${user.id}/status`, {
                    method: 'PATCH',
                    body: { status: 'ACTIVE' },
                  });
                  await onChanged();
                }, t('saved'))
              }
            >
              {t('enable')}
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t('disable_confirm', { name: user.givenName }))) return;
                void run(async () => {
                  await session.api(`${base}/users/${user.id}/status`, {
                    method: 'PATCH',
                    body: { status: 'DISABLED' },
                  });
                  await onChanged();
                }, t('saved'));
              }}
            >
              {t('disable')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function MembershipRow({
  membership,
  roles,
  where,
  canEdit,
  base,
  busy,
  run,
  onChanged,
}: {
  readonly membership: StaffMembership;
  readonly roles: readonly RoleSummary[];
  readonly where: string;
  readonly canEdit: boolean;
  readonly base: string;
  readonly busy: boolean;
  readonly run: Run;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslations('staff.people');
  const session = useSession();
  const [codes, setCodes] = useState<string[]>(membership.roles.map((r) => r.code));
  const changed =
    [...codes].sort().join() !==
    membership.roles
      .map((r) => r.code)
      .sort()
      .join();
  return (
    <li className="rounded-xl border border-slate-200 p-3" data-membership={where}>
      <p className="mb-2 text-sm font-semibold">{where}</p>
      {canEdit ? (
        <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <legend className="sr-only">{t('roles_at', { where })}</legend>
          {roles.map((r) => (
            <label key={r.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={codes.includes(r.code)}
                onChange={(e) =>
                  setCodes(
                    e.target.checked ? [...codes, r.code] : codes.filter((c) => c !== r.code),
                  )
                }
              />
              {r.name}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm">{membership.roles.map((r) => r.name).join(' · ')}</p>
      )}
      {canEdit && (
        <div className="mt-2 flex gap-2">
          <Button
            variant="secondary"
            disabled={busy || !changed || codes.length === 0}
            onClick={() =>
              void run(async () => {
                await session.api(`${base}/memberships/${membership.id}/roles`, {
                  method: 'PUT',
                  body: { roleCodes: codes },
                });
                await onChanged();
              }, t('saved'))
            }
          >
            {t('save_roles')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await session.api(`${base}/memberships/${membership.id}`, { method: 'DELETE' });
                await onChanged();
              }, t('saved'))
            }
          >
            {t('remove_access', { where })}
          </Button>
        </div>
      )}
    </li>
  );
}
