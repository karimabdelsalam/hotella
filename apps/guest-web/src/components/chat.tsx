'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, cx } from '@hotella/ui';
import { Link } from '../i18n/navigation';
import { api, ApiError } from '../lib/api';
import type { Conversation } from '../lib/types';
import { SignedOut, useGuest } from './home';
import { ErrorText, TopBar } from './ui';

/**
 * Chat with the hotel on the guest web: the stay's one conversation, also used by WhatsApp (Spec §18.1). The session
 * stays in an httpOnly cookie, so the page refreshes the thread on an interval instead of opening its own socket.
 */
const REFRESH_MS = 5_000;

export function Chat() {
  const t = useTranslations('portal.chat');
  const locale = useLocale();
  const me = useGuest();
  const [thread, setThread] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<Conversation>('guest/conversation', locale)
      .then(setThread)
      .catch(() => undefined);
  }, [locale]);

  useEffect(() => {
    if (!me || me === 'signed-out') return;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [me, load]);

  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [thread?.messages.length]);

  if (me === 'signed-out') return <SignedOut />;
  return (
    <>
      <TopBar title={me?.property?.name} />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-3 p-4">
        <Link href="/" className="text-sm text-slate-600">
          <span aria-hidden className="inline-block rtl:rotate-180">
            ‹
          </span>{' '}
          {t('back')}
        </Link>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <ol className="flex flex-1 flex-col gap-2" aria-live="polite">
          {thread?.messages.length === 0 && (
            <li className="text-sm text-slate-500">{t('empty')}</li>
          )}
          {thread?.messages.map((m) => (
            <li
              key={m.id}
              data-direction={m.direction}
              data-sender={m.senderType}
              className={cx(
                'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                m.direction === 'INBOUND'
                  ? 'self-end bg-[var(--brand-primary,#1f2937)] text-white'
                  : m.senderType === 'SYSTEM'
                    ? 'self-center bg-slate-100 text-slate-700'
                    : 'self-start bg-white shadow-sm',
              )}
            >
              {m.body}
            </li>
          ))}
        </ol>
        <div ref={end} />
        {error && <ErrorText>{error}</ErrorText>}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            setBusy(true);
            setError(null);
            api('guest/conversation/messages', locale, { body: { body: draft.trim() } })
              .then(() => {
                setDraft('');
                load();
              })
              .catch((err: unknown) =>
                setError(err instanceof ApiError && err.detail ? err.detail : t('error')),
              )
              .finally(() => setBusy(false));
          }}
        >
          <input
            aria-label={t('placeholder')}
            placeholder={t('placeholder')}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-base text-start"
            value={draft}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            {t('send')}
          </Button>
        </form>
      </main>
    </>
  );
}
