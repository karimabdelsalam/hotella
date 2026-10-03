'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@hotella/ui';
import { Link, useRouter } from '../i18n/navigation';
import { api, ApiError, call } from '../lib/api';
import { useBrand } from '../lib/brand';
import type { Catalog, Me } from '../lib/types';
import { Card, Page, TopBar } from './ui';

/** Loads the guest (`/guest/me`); null while loading, 'signed-out' without a valid session. */
export function useGuest(): Me | null | 'signed-out' {
  const locale = useLocale();
  const { set } = useBrand();
  const [me, setMe] = useState<Me | null | 'signed-out'>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A dropped connection is retried a few times; only the API saying "no session" signs the guest out.
    const attempt = (left: number) =>
      api<Me>('guest/me', locale)
        .then((m) => {
          if (!live) return;
          setMe(m);
          set(m.branding);
        })
        .catch((e: unknown) => {
          if (!live) return;
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setMe('signed-out');
          else if (left > 0) timer = setTimeout(() => void attempt(left - 1), 1000);
        });
    void attempt(3);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // `set` is stable for the page's lifetime.
  }, [locale]);
  return me;
}

export function SignedOut() {
  const t = useTranslations('portal.home');
  return (
    <>
      <TopBar />
      <Page>
        <Card>
          <h1 className="text-lg font-semibold">{t('signed_out_title')}</h1>
          <p className="mt-2 text-sm text-slate-600">{t('signed_out_body')}</p>
        </Card>
      </Page>
    </>
  );
}

type Signal = 'DND' | 'MAKE_UP_ROOM';

/** Do not disturb / please make up my room for the guest's current room (each turns the other off). */
function RoomSignals() {
  const t = useTranslations('portal.home');
  const locale = useLocale();
  const [active, setActive] = useState<readonly Signal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<{ active: Signal[] }>('guest/room-signals', locale)
      .then((r) => setActive(r.active))
      .catch(() => setActive(null));
  }, [locale]);
  if (!active) return null;
  const toggle = async (signal: Signal) => {
    setBusy(true);
    setFailed(false);
    try {
      const r = await api<{ active: Signal[] }>('guest/room-signals', locale, {
        body: { signal, active: !active.includes(signal) },
      });
      setActive(r.active.filter((s) => s === 'DND' || s === 'MAKE_UP_ROOM'));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const item = (signal: Signal, label: string, on: string) => {
    const pressed = active.includes(signal);
    return (
      <li>
        <button
          type="button"
          aria-pressed={pressed}
          disabled={busy}
          data-signal={signal}
          onClick={() => void toggle(signal)}
          className={`w-full rounded-lg border px-3 py-2 text-start text-sm ${
            pressed ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white'
          }`}
        >
          {label}
        </button>
        {pressed && <p className="mt-1 text-xs text-slate-600">{on}</p>}
      </li>
    );
  };
  return (
    <section aria-labelledby="room-signals" className="flex flex-col gap-2">
      <h2 id="room-signals" className="text-sm font-semibold uppercase text-slate-500">
        {t('room_signals')}
      </h2>
      <ul className="grid grid-cols-2 gap-2">
        {item('DND', t('dnd'), t('dnd_on'))}
        {item('MAKE_UP_ROOM', t('make_up'), t('make_up_on'))}
      </ul>
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          {t('signal_failed')}
        </p>
      )}
    </section>
  );
}

/** The guest's home: greeting, room, the service catalog and links to requests and chat. */
export function Home() {
  const t = useTranslations('portal.home');
  const locale = useLocale();
  const router = useRouter();
  const me = useGuest();
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    if (!me || me === 'signed-out' || !me.scopes.includes('SERVICE_REQUEST')) return;
    api<Catalog>('guest/services', locale)
      .then(setCatalog)
      .catch(() => setCatalog({ categories: [] }));
  }, [me, locale]);

  if (me === 'signed-out') return <SignedOut />;
  return (
    <>
      <TopBar title={me?.property?.name}>
        {me && (
          <Button
            variant="ghost"
            className="text-white hover:bg-white/10"
            onClick={async () => {
              await call('/bff/logout', locale, { method: 'POST' }).catch(() => undefined);
              router.refresh();
              window.location.reload();
            }}
          >
            {t('sign_out')}
          </Button>
        )}
      </TopBar>
      <Page>
        {!me && <p className="text-slate-500">{t('loading')}</p>}
        {me && (
          <>
            <Card>
              <h1 className="text-xl font-semibold">
                {me.guest.givenName
                  ? t('welcome', { name: me.guest.givenName })
                  : t('welcome_plain')}
              </h1>
              {me.stay?.room && (
                <p className="mt-1 text-sm text-slate-600">
                  {t('room', { room: me.stay.room.number })}
                </p>
              )}
              {me.branding?.welcomeText && (
                <p className="mt-2 text-sm text-slate-700">{me.branding.welcomeText}</p>
              )}
              <nav className="mt-3 flex flex-wrap gap-2">
                {me.scopes.includes('SERVICE_REQUEST') && (
                  <Link
                    href="/requests"
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                  >
                    {t('my_requests')}
                  </Link>
                )}
                {me.scopes.includes('CHAT') && (
                  <Link
                    href="/chat"
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                  >
                    {t('chat')}
                  </Link>
                )}
              </nav>
            </Card>
            {me.stay?.room && me.scopes.includes('SERVICE_REQUEST') && <RoomSignals />}
            {catalog?.categories.map((c) => (
              <section
                key={c.code}
                aria-labelledby={`cat-${c.code}`}
                className="flex flex-col gap-2"
              >
                <h2 id={`cat-${c.code}`} className="text-sm font-semibold uppercase text-slate-500">
                  {c.name}
                </h2>
                <ul className="flex flex-col gap-2">
                  {c.services.map((s) => (
                    <li key={s.code}>
                      <Link
                        href={`/services/${s.code}`}
                        className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm"
                        data-service={s.code}
                      >
                        <span className="flex flex-1 flex-col text-start">
                          <span className="font-medium">{s.name}</span>
                          {s.shortDescription && (
                            <span className="text-sm text-slate-600">{s.shortDescription}</span>
                          )}
                        </span>
                        {!s.openNow && (
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                            {t('closed_now')}
                          </span>
                        )}
                        <span aria-hidden className="text-slate-400 rtl:rotate-180">
                          ›
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {catalog && catalog.categories.length === 0 && (
              <p className="text-sm text-slate-500">{t('no_services')}</p>
            )}
          </>
        )}
      </Page>
    </>
  );
}
