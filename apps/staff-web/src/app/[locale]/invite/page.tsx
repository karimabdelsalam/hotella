'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@hotella/ui';
import { Header } from '../../../components/header';
import { Link } from '../../../i18n/navigation';
import { ApiError } from '../../../lib/session';

const field =
  'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none';

/**
 * Accepting an invitation (BUILD_PLAN pilot P.3): the link's fragment (`#token=…&hotel=…`) never reaches a server
 * log; the invitee chooses a password (the API checks the policy) and then signs in with the hotel code.
 */
export default function InvitePage() {
  const t = useTranslations('staff.invite');
  const [token, setToken] = useState<string | null>(null);
  const [hotel, setHotel] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    setToken(params.get('token'));
    setHotel(params.get('hotel'));
    // The secret leaves the address bar (history, screenshots) as soon as it is read.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = String(data.get('password') ?? '');
    if (password !== String(data.get('confirm') ?? '')) return setError(t('mismatch'));
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/hotella/auth/invitations/accept', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept-language': document.documentElement.lang,
        },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          code?: string;
          detail?: string;
        } | null;
        throw new ApiError(res.status, body?.code ?? null, body?.detail ?? null);
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError && err.detail ? err.detail : t('failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header />
      <main className="mx-auto mt-16 w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-2 text-lg font-semibold">{t('title')}</h1>
        {done ? (
          <div className="space-y-3 text-sm" role="status">
            <p>{t('done')}</p>
            {hotel && (
              <p>
                {t('hotel_code')}{' '}
                <strong dir="ltr" data-testid="hotel-code">
                  {hotel}
                </strong>
              </p>
            )}
            <Link
              href={hotel ? `/login?hotel=${encodeURIComponent(hotel)}` : '/login'}
              className="inline-block rounded-md bg-[var(--brand-primary,#0f4c81)] px-4 py-2 font-semibold text-white"
            >
              {t('sign_in')}
            </Link>
          </div>
        ) : token === null ? (
          <p className="text-sm text-slate-600">{t('no_token')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <p className="text-sm text-slate-600">{t('hint')}</p>
            <label className="block text-sm">
              {t('password')}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                className={field}
                dir="ltr"
              />
            </label>
            <label className="block text-sm">
              {t('confirm')}
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                className={field}
                dir="ltr"
              />
            </label>
            {error && (
              <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {t('submit')}
            </Button>
          </form>
        )}
      </main>
    </>
  );
}
