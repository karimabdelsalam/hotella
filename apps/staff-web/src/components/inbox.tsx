'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, cx } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { useInboxRealtime } from '../lib/realtime';
import { ApiError, useSession } from '../lib/session';
import type {
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  Me,
  PropertySummary,
} from '../lib/types';

const FILTERS = {
  waiting: ['WAITING_STAFF', 'HANDED_OFF'],
  open: ['OPEN', 'WAITING_GUEST', 'WAITING_STAFF', 'HANDED_OFF'],
  closed: ['CLOSED'],
} as const satisfies Record<string, readonly ConversationStatus[]>;
type Filter = keyof typeof FILTERS;

const STATUS_TONE: Record<ConversationStatus, 'neutral' | 'info' | 'warning' | 'success'> = {
  OPEN: 'info',
  WAITING_GUEST: 'neutral',
  WAITING_STAFF: 'warning',
  HANDED_OFF: 'success',
  CLOSED: 'neutral',
};

function guestName(c: ConversationSummary, unverified: string): string {
  if (!c.guest) return c.contact ? `${unverified} · ${c.contact}` : unverified;
  return [c.guest.givenName, c.guest.familyName].filter(Boolean).join(' ');
}

/**
 * The unified inbox (Spec §18): one list across channels, the thread with who and where the guest is (from the PMS
 * stay, never from the phone) and the open work for that stay; reply, take over (AI off) and close. Every string comes
 * from the shared catalog; layout uses logical properties only, so it mirrors in Arabic.
 */
export function InboxApp({ realtimeUrl }: { readonly realtimeUrl: string }) {
  const t = useTranslations('staff');
  const format = useFormatter();
  const session = useSession();
  const router = useRouter();
  const [properties, setProperties] = useState<PropertySummary[] | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('waiting');
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);

  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : t('inbox.error')),
    [t],
  );

  // Properties where this person may read the inbox.
  useEffect(() => {
    if (session.state !== 'signed-in') return;
    void (async () => {
      try {
        const me = await session.api<Me>('/me');
        const all = await session.api<PropertySummary[]>('/properties');
        const tenantWide = me.memberships.some(
          (m) => m.propertyId === null && m.permissions.includes('inbox.read'),
        );
        const allowed = all.filter(
          (p) =>
            tenantWide ||
            me.memberships.some(
              (m) => m.propertyId === p.id && m.permissions.includes('inbox.read'),
            ),
        );
        setProperties(allowed);
        setPropertyId((current) => current ?? allowed[0]?.id ?? null);
      } catch (e) {
        fail(e);
      }
    })();
  }, [session, fail]);

  const loadList = useCallback(async () => {
    if (!propertyId) return;
    const query = FILTERS[filter].map((s) => `status=${s}`).join('&');
    setList(
      await session.api<ConversationSummary[]>(`/properties/${propertyId}/conversations?${query}`),
    );
  }, [session, propertyId, filter]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (!propertyId) return;
      setDetail(
        await session.api<ConversationDetail>(`/properties/${propertyId}/conversations/${id}`),
      );
    },
    [session, propertyId],
  );

  useEffect(() => {
    loadList().catch(fail);
  }, [loadList, fail]);
  useEffect(() => {
    if (selected) loadDetail(selected).catch(fail);
    else setDetail(null);
  }, [selected, loadDetail, fail]);

  const live = useInboxRealtime(realtimeUrl, propertyId, session.token, (conversationId) => {
    loadList().catch(fail);
    if (conversationId === selected) loadDetail(conversationId).catch(fail);
  });

  async function act(path: string, body: unknown = {}) {
    if (!propertyId || !detail) return;
    try {
      await session.api(`/properties/${propertyId}/conversations/${detail.id}/${path}`, {
        method: 'POST',
        body,
      });
      await Promise.all([loadDetail(detail.id), loadList()]);
    } catch (e) {
      fail(e);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    await act('messages', { body: draft.trim() });
    setDraft('');
  }

  if (session.state !== 'signed-in') return <Header />;
  return (
    <>
      <Header />
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 text-sm">
        <h1 className="font-semibold">{t('inbox.title')}</h1>
        {properties && properties.length > 1 && (
          <select
            aria-label={t('inbox.property')}
            className="rounded border border-slate-300 px-2 py-1"
            value={propertyId ?? ''}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setSelected(null);
            }}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span
          className={cx('ms-auto text-xs', live ? 'text-emerald-700' : 'text-slate-500')}
          data-testid="live"
        >
          {live ? t('inbox.live') : t('inbox.offline')}
        </span>
      </div>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('inbox.no_property')}</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[20rem_1fr]">
          <nav className="border-e border-slate-200 bg-white" aria-label={t('inbox.title')}>
            <div className="flex gap-1 border-b border-slate-200 p-2" role="tablist">
              {(Object.keys(FILTERS) as Filter[]).map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cx(
                    'rounded px-2 py-1 text-xs',
                    filter === f ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100',
                  )}
                >
                  {t(`inbox.filter_${f}`)}
                </button>
              ))}
            </div>
            {list.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">{t('inbox.empty')}</p>
            ) : (
              <ul>
                {list.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => setSelected(c.id)}
                      className={cx(
                        'block w-full border-b border-slate-100 px-3 py-2 text-start hover:bg-slate-50',
                        selected === c.id && 'bg-sky-50',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {guestName(c, t('inbox.unverified'))}
                        </span>
                        <span className="ms-auto shrink-0">
                          <Badge tone={STATUS_TONE[c.status]}>
                            {t(`status.${c.status.toLowerCase()}`)}
                          </Badge>
                        </span>
                      </span>
                      <span className="block text-xs text-slate-500">
                        {c.stay?.room
                          ? t('inbox.room', { number: c.stay.room.number })
                          : t('inbox.no_room')}{' '}
                        · {format.relativeTime(new Date(c.lastMessageAt))}
                      </span>
                      {c.lastMessage?.preview && (
                        <span className="block truncate text-xs text-slate-600">
                          {c.lastMessage.preview}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <section className="flex min-h-0 flex-col">
            {!detail ? (
              <p className="p-6 text-sm text-slate-500">{t('inbox.select')}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
                  <h2 className="text-base font-semibold">
                    {guestName(detail, t('inbox.unverified'))}
                  </h2>
                  {detail.stay && (
                    <Badge tone="info">{t(`stay.${detail.stay.status.toLowerCase()}`)}</Badge>
                  )}
                  <span className="text-sm text-slate-600">
                    {detail.stay?.room
                      ? t('inbox.room', { number: detail.stay.room.number })
                      : t('inbox.no_room')}
                  </span>
                  {!detail.verified && <Badge tone="warning">{t('inbox.unverified')}</Badge>}
                  <span className="ms-auto flex gap-2">
                    {detail.status !== 'HANDED_OFF' && detail.status !== 'CLOSED' && (
                      <Button variant="secondary" onClick={() => act('takeover')}>
                        {t('inbox.take_over')}
                      </Button>
                    )}
                    {detail.status !== 'CLOSED' && (
                      <Button variant="danger" onClick={() => act('close')}>
                        {t('inbox.close')}
                      </Button>
                    )}
                  </span>
                </div>
                <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
                  <span className="font-medium">{t('inbox.open_work')}: </span>
                  {detail.openWork.length === 0 ? (
                    <span className="text-slate-500">{t('inbox.no_open_work')}</span>
                  ) : (
                    detail.openWork.map((w) => (
                      <span key={w.id} className="me-2">
                        <Badge
                          tone={
                            w.priority === 'HIGH' || w.priority === 'CRITICAL'
                              ? 'danger'
                              : 'neutral'
                          }
                        >
                          {w.kind}
                        </Badge>
                      </span>
                    ))
                  )}
                </div>
                <ol
                  className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4"
                  aria-live="polite"
                >
                  {detail.messages
                    .filter((m) => m.type !== 'SYSTEM')
                    .map((m) => (
                      <li
                        key={m.id}
                        className={cx(
                          'max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm',
                          m.direction === 'INBOUND' ? 'self-start bg-white' : 'self-end bg-sky-100',
                        )}
                        data-direction={m.direction}
                      >
                        <span className="block text-[10px] uppercase tracking-wide text-slate-500">
                          {t(
                            `sender.${m.senderType === 'EXTERNAL' ? 'system' : m.senderType.toLowerCase()}`,
                          )}{' '}
                          ·{' '}
                          {format.dateTime(new Date(m.createdAt), {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        <span className="whitespace-pre-wrap" dir="auto">
                          {m.body}
                        </span>
                        {m.deliveryStatus === 'FAILED' && (
                          <span className="block text-xs text-red-700">{t('inbox.failed')}</span>
                        )}
                      </li>
                    ))}
                </ol>
                {detail.status !== 'CLOSED' && (
                  <form
                    onSubmit={send}
                    className="flex gap-2 border-t border-slate-200 bg-white p-3"
                  >
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t('inbox.reply_placeholder')}
                      aria-label={t('inbox.reply_placeholder')}
                      rows={2}
                      dir="auto"
                      className="min-h-0 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <Button type="submit" disabled={!draft.trim()}>
                      {t('inbox.send')}
                    </Button>
                  </form>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
