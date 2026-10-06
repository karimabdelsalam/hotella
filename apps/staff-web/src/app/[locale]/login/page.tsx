'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@hotella/ui';
import { Header } from '../../../components/header';
import { takeNextPath } from '../../../components/shell';
import { useRouter } from '../../../i18n/navigation';
import { ApiError, useSession } from '../../../lib/session';

const field =
  'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-600 focus:outline-none';

export default function LoginPage() {
  const t = useTranslations('staff.login');
  const session = useSession();
  const router = useRouter();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An accepted invitation brings the hotel code along (`/login?hotel=CODE`).
  const [hotel, setHotel] = useState('');
  useEffect(() => setHotel(new URLSearchParams(window.location.search).get('hotel') ?? ''), []);

  useEffect(() => {
    if (session.state === 'signed-in') router.replace(takeNextPath() ?? '/home');
  }, [session.state, router]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (challenge) await session.verifyMfa(challenge, String(data.get('code') ?? ''));
      else {
        const next = await session.signIn({
          ...(data.get('tenantCode') ? { tenantCode: String(data.get('tenantCode')) } : {}),
          email: String(data.get('email') ?? ''),
          password: String(data.get('password') ?? ''),
        });
        if (next) return setChallenge(next.challengeToken);
      }
      // Signed in: the effect above takes the person where they were going.
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
        <h1 className="mb-4 text-lg font-semibold">{t('title')}</h1>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {challenge ? (
            <label className="block text-sm">
              {t('code')}
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                required
                className={field}
                dir="ltr"
              />
              <span className="mt-1 block text-xs text-slate-500">{t('code_hint')}</span>
            </label>
          ) : (
            <>
              <label className="block text-sm">
                {t('hotel_code')}
                <input
                  name="tenantCode"
                  autoComplete="organization"
                  className={field}
                  dir="ltr"
                  defaultValue={hotel}
                  key={hotel}
                />
              </label>
              <label className="block text-sm">
                {t('email')}
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  className={field}
                  dir="ltr"
                />
              </label>
              <label className="block text-sm">
                {t('password')}
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className={field}
                  dir="ltr"
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="w-full">
            {challenge ? t('verify') : t('submit')}
          </Button>
        </form>
      </main>
    </>
  );
}
