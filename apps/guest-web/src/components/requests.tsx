'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Badge, Button } from '@hotella/ui';
import { Link } from '../i18n/navigation';
import { api, ApiError } from '../lib/api';
import type { GuestRequest } from '../lib/types';
import { SignedOut, useGuest } from './home';
import { ErrorText, Page, TopBar } from './ui';

const TONE = {
  OPEN: 'info',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
} as const;
const REFRESH_MS = 15_000;

/** The guest's requests and where they stand; the guest may withdraw one nobody started. */
export function Requests() {
  const t = useTranslations('portal.requests');
  const format = useFormatter();
  const locale = useLocale();
  const me = useGuest();
  const [items, setItems] = useState<readonly GuestRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<GuestRequest[]>('guest/requests', locale)
      .then(setItems)
      .catch(() => undefined);
  }, [locale]);

  useEffect(() => {
    if (!me || me === 'signed-out') return;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [me, load]);

  if (me === 'signed-out') return <SignedOut />;
  return (
    <>
      <TopBar title={me?.property?.name} />
      <Page>
        <Link href="/" className="text-sm text-slate-600">
          <span aria-hidden className="inline-block rtl:rotate-180">
            ‹
          </span>{' '}
          {t('back')}
        </Link>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {items && items.length === 0 && <p className="text-sm text-slate-500">{t('empty')}</p>}
        <ul className="flex flex-col gap-2">
          {items?.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-3 rounded-lg bg-white p-3 shadow-sm"
              data-request={r.serviceCode}
            >
              <span className="flex flex-1 flex-col text-start">
                <span className="font-medium">{r.serviceName}</span>
                <span className="text-xs text-slate-500">
                  {format.dateTime(new Date(r.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </span>
              <Badge tone={TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
              {r.status === 'OPEN' && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    api(`guest/requests/${r.id}/cancel`, locale, { method: 'POST' })
                      .then(load)
                      .catch((e: unknown) =>
                        setError(e instanceof ApiError && e.detail ? e.detail : t('error')),
                      );
                  }}
                >
                  {t('cancel')}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {error && <ErrorText>{error}</ErrorText>}
      </Page>
    </>
  );
}
