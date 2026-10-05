'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  Button,
  ChatIcon,
  ChevronIcon,
  cx,
  DiningIcon,
  ListIcon,
  MoonIcon,
  SparkleIcon,
} from '@hotella/ui';
import { Link, useRouter } from '../i18n/navigation';
import { api, ApiError, call } from '../lib/api';
import { useBrand } from '../lib/brand';
import type { Catalog, Me } from '../lib/types';
import { Card, Page, SectionTitle, TopBar } from './ui';

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
    const Icon = signal === 'DND' ? MoonIcon : SparkleIcon;
    return (
      <li>
        <button
          type="button"
          aria-pressed={pressed}
          disabled={busy}
          data-signal={signal}
          onClick={() => void toggle(signal)}
          className={cx(
            'flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-3 text-start text-sm font-semibold shadow-sm ring-1 transition',
            pressed
              ? 'bg-brand text-white ring-transparent'
              : 'bg-white text-slate-800 ring-slate-900/5',
          )}
        >
          <span
            className={cx(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-full',
              pressed ? 'bg-white/20' : 'bg-brand-soft text-brand',
            )}
          >
            <Icon className="size-4" />
          </span>
          {label}
        </button>
        {pressed && <p className="mt-1.5 px-1 text-xs text-slate-600">{on}</p>}
      </li>
    );
  };
  return (
    <section aria-labelledby="room-signals" className="flex flex-col gap-2">
      <SectionTitle id="room-signals">{t('room_signals')}</SectionTitle>
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
  const [dining, setDining] = useState(false);

  useEffect(() => {
    if (!me || me === 'signed-out' || !me.scopes.includes('SERVICE_REQUEST')) return;
    api<Catalog>('guest/services', locale)
      .then(setCatalog)
      .catch(() => setCatalog({ categories: [] }));
  }, [me, locale]);

  // Restaurants show only where the hotel has some the guest can book (module licensed, restaurants active).
  useEffect(() => {
    if (!me || me === 'signed-out' || !me.scopes.includes('DINING')) return;
    api<{ restaurants: unknown[] }>('guest/restaurants', locale)
      .then((r) => setDining(r.restaurants.length > 0))
      .catch(() => setDining(false));
  }, [me, locale]);

  if (me === 'signed-out') return <SignedOut />;
  return (
    <>
      <TopBar title={me?.property?.name}>
        {me && (
          <Button
            variant="ghost"
            className="shrink-0 rounded-full px-2.5 py-1.5 text-xs text-white hover:bg-white/15"
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
            <Card className="overflow-hidden">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-bold leading-snug">
                    {me.guest.givenName
                      ? t('welcome', { name: me.guest.givenName })
                      : t('welcome_plain')}
                  </h1>
                  {me.branding?.welcomeText && (
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {me.branding.welcomeText}
                    </p>
                  )}
                </div>
                {me.stay?.room && (
                  <span className="bg-brand-soft text-brand shrink-0 rounded-full px-3 py-1 text-sm font-bold">
                    {t('room', { room: me.stay.room.number })}
                  </span>
                )}
              </div>
              <nav className="mt-4 grid grid-cols-2 gap-2">
                {me.scopes.includes('SERVICE_REQUEST') && (
                  <Link
                    href="/requests"
                    className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-semibold ring-1 ring-slate-900/5 hover:bg-slate-100"
                  >
                    <ListIcon className="text-brand size-5" />
                    {t('my_requests')}
                  </Link>
                )}
                {me.scopes.includes('CHAT') && (
                  <Link
                    href="/chat"
                    className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-semibold ring-1 ring-slate-900/5 hover:bg-slate-100"
                  >
                    <ChatIcon className="text-brand size-5" />
                    {t('chat')}
                  </Link>
                )}
                {dining && (
                  <Link
                    href="/restaurants"
                    className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-semibold ring-1 ring-slate-900/5 hover:bg-slate-100"
                  >
                    <DiningIcon className="text-brand size-5" />
                    {t('restaurants')}
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
                <SectionTitle id={`cat-${c.code}`}>{c.name}</SectionTitle>
                <ul className="flex flex-col gap-2">
                  {c.services.map((s) => (
                    <li key={s.code}>
                      <Link
                        href={`/services/${s.code}`}
                        className="flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-slate-900/5 transition hover:shadow-md"
                        data-service={s.code}
                      >
                        <span
                          aria-hidden
                          className="bg-brand-soft text-brand inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-base font-bold"
                        >
                          {Array.from(s.name)[0]}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col text-start">
                          <span className="font-semibold">{s.name}</span>
                          {s.shortDescription && (
                            <span className="text-sm text-slate-600">{s.shortDescription}</span>
                          )}
                        </span>
                        {!s.openNow && (
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                            {t('closed_now')}
                          </span>
                        )}
                        <ChevronIcon className="size-4 shrink-0 text-slate-400" />
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
