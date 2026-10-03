'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@hotella/ui';
import { useRouter } from '../i18n/navigation';
import { api, ApiError, call } from '../lib/api';
import { useBrand } from '../lib/brand';
import { Card, ErrorText, Field, Page, TopBar } from './ui';

type Step =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'name' }
  | { kind: 'phone' }
  | { kind: 'code'; handle: string; reference: string; sentVia: string; resendAfter: number };

interface OtpRequested {
  readonly handle: string;
  readonly reference: string;
  readonly sentVia: string;
  readonly resendAfter: string;
}

/**
 * Passwordless activation (Spec §19–§20, ADR-0011): link or room QR → (QR: last name) → mobile → code by WhatsApp or
 * SMS → session. The session token is set as an httpOnly cookie by the BFF; this page never sees it. When no code
 * arrives the guest shows the reference at the front desk, which confirms them in person.
 */
export function Activation({
  mode,
  token,
}: {
  readonly mode: 'link' | 'qr';
  readonly token: string;
}) {
  const t = useTranslations('portal.activation');
  const locale = useLocale();
  const router = useRouter();
  const brand = useBrand();
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [hotel, setHotel] = useState<{ name: string; room?: string } | null>(null);
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    const start: Promise<{ propertyId: string; name: string; room?: string }> =
      mode === 'link'
        ? api<{ propertyId: string; propertyName: string }>('guest/activation/start', locale, {
            body: { token },
          }).then((r) => ({ propertyId: r.propertyId, name: r.propertyName }))
        : api<{ propertyId: string; propertyName: string; roomNumber: string }>(
            `guest/qr/${encodeURIComponent(token)}`,
            locale,
          ).then((r) => ({ propertyId: r.propertyId, name: r.propertyName, room: r.roomNumber }));
    start
      .then((r) => {
        if (!live) return;
        setHotel({ name: r.name, room: r.room });
        brand.load(r.propertyId);
        setStep({ kind: mode === 'qr' ? 'name' : 'phone' });
      })
      .catch(() => live && setStep({ kind: 'invalid' }));
    return () => {
      live = false;
    };
    // The token and mode identify the page; the brand loader is stable.
  }, [mode, token, locale]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError && e.detail ? e.detail : t('error'));
    } finally {
      setBusy(false);
    }
  };

  const requested = (r: OtpRequested) =>
    setStep({
      kind: 'code',
      handle: r.handle,
      reference: r.reference,
      sentVia: r.sentVia,
      resendAfter: Date.parse(r.resendAfter),
    });

  return (
    <>
      <TopBar title={hotel?.name} />
      <Page>
        {step.kind === 'loading' && <p className="text-slate-500">{t('loading')}</p>}
        {step.kind === 'invalid' && (
          <Card>
            <h1 className="text-lg font-semibold">{t('invalid_title')}</h1>
            <p className="mt-2 text-sm text-slate-600">{t('invalid_body')}</p>
          </Card>
        )}
        {step.kind !== 'loading' && step.kind !== 'invalid' && (
          <Card className="flex flex-col gap-4">
            <div>
              <h1 className="text-lg font-semibold">{t('title', { hotel: hotel?.name ?? '' })}</h1>
              {hotel?.room && (
                <p className="text-sm text-slate-600">{t('room', { room: hotel.room })}</p>
              )}
            </div>
            {step.kind === 'name' && (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api(`guest/qr/${encodeURIComponent(token)}/verify`, locale, {
                      body: { lastName },
                    });
                    setStep({ kind: 'phone' });
                  });
                }}
              >
                <Field
                  label={t('last_name')}
                  autoComplete="family-name"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
                <Button type="submit" disabled={busy || !lastName.trim()}>
                  {t('continue')}
                </Button>
              </form>
            )}
            {step.kind === 'phone' && (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () =>
                    requested(
                      await api<OtpRequested>('guest/activation/otp/request', locale, {
                        body:
                          mode === 'link' ? { token, phone } : { qrToken: token, lastName, phone },
                      }),
                    ),
                  );
                }}
              >
                <Field
                  label={t('phone')}
                  hint={t('phone_hint')}
                  type="tel"
                  dir="ltr"
                  autoComplete="tel"
                  inputMode="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <Button type="submit" disabled={busy || phone.trim().length < 6}>
                  {t('send_code')}
                </Button>
              </form>
            )}
            {step.kind === 'code' && (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await call('/bff/verify', locale, { body: { handle: step.handle, code } });
                    router.replace('/');
                  });
                }}
              >
                <p className="text-sm text-slate-600">
                  {step.sentVia === 'WHATSAPP' ? t('sent_whatsapp') : t('sent_sms')}
                </p>
                <Field
                  label={t('code')}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <Button type="submit" disabled={busy || code.length !== 6}>
                  {t('verify')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || now < step.resendAfter}
                  onClick={() =>
                    void run(async () => {
                      const r = await api<{ sentVia: string; resendAfter: string }>(
                        'guest/activation/otp/resend',
                        locale,
                        { body: { handle: step.handle } },
                      );
                      setStep({
                        ...step,
                        sentVia: r.sentVia,
                        resendAfter: Date.parse(r.resendAfter),
                      });
                    })
                  }
                >
                  {now < step.resendAfter
                    ? t('resend_in', { seconds: Math.ceil((step.resendAfter - now) / 1000) })
                    : t('resend')}
                </Button>
                <div className="rounded-md bg-slate-100 p-3 text-sm text-slate-700">
                  <p>{t('front_desk')}</p>
                  <p
                    className="mt-1 text-center font-mono text-xl tracking-widest"
                    dir="ltr"
                    data-testid="reference"
                  >
                    {step.reference}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    className="mt-2 w-full"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await call('/bff/complete', locale, { body: { handle: step.handle } });
                        router.replace('/');
                      })
                    }
                  >
                    {t('front_desk_done')}
                  </Button>
                </div>
              </form>
            )}
            {error && <ErrorText>{error}</ErrorText>}
          </Card>
        )}
      </Page>
    </>
  );
}
