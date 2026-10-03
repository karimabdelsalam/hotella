'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@hotella/ui';
import { Link } from '../i18n/navigation';
import { api, ApiError } from '../lib/api';
import type { Service, ServiceField } from '../lib/types';
import { SignedOut, useGuest } from './home';
import { Card, ErrorText, Page, TopBar } from './ui';

type Values = Record<string, string | number | boolean>;

/**
 * Asks for one service (Spec §7): the fields the service version requires, labelled in the guest's language. The API
 * decides everything (eligibility, duplicates, availability); a repeat of an open request is related to it.
 */
export function ServiceForm({ code }: { readonly code: string }) {
  const t = useTranslations('portal.service');
  const locale = useLocale();
  const me = useGuest();
  const [service, setService] = useState<Service | null | 'missing'>(null);
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'created' | 'related' | null>(null);

  useEffect(() => {
    if (!me || me === 'signed-out') return;
    api<Service>(`guest/services/${encodeURIComponent(code)}`, locale)
      .then(setService)
      .catch(() => setService('missing'));
  }, [me, code, locale]);

  if (me === 'signed-out') return <SignedOut />;
  const set = (field: string, value: string | number | boolean | undefined) =>
    setValues((v) => {
      const next = { ...v };
      if (value === undefined || value === '') delete next[field];
      else next[field] = value;
      return next;
    });

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
        {service === 'missing' && (
          <Card>
            <p>{t('not_available')}</p>
          </Card>
        )}
        {service && service !== 'missing' && (
          <Card className="flex flex-col gap-4">
            <div>
              <h1 className="text-xl font-semibold">{service.name}</h1>
              {service.description && (
                <p className="mt-1 text-sm text-slate-600">{service.description}</p>
              )}
              {!service.openNow && <p className="mt-1 text-sm text-amber-800">{t('closed_now')}</p>}
            </div>
            {done ? (
              <div role="status" className="flex flex-col gap-3">
                <p className="font-medium">{done === 'related' ? t('related') : t('created')}</p>
                <Link
                  href="/requests"
                  className="rounded-md bg-[var(--brand-primary,#1f2937)] px-3 py-2 text-center text-sm text-white"
                >
                  {t('see_requests')}
                </Link>
              </div>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError(null);
                  api<{ related: boolean }>('guest/requests', locale, {
                    body: { serviceCode: service.code, fields: values },
                  })
                    .then((r) => setDone(r.related ? 'related' : 'created'))
                    .catch((err: unknown) =>
                      setError(err instanceof ApiError && err.detail ? err.detail : t('error')),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {service.fields.map((f) => (
                  <FieldInput
                    key={f.code}
                    field={f}
                    value={values[f.code]}
                    onChange={(v) => set(f.code, v)}
                  />
                ))}
                {error && <ErrorText>{error}</ErrorText>}
                <Button type="submit" disabled={busy} className="py-2">
                  {t('submit')}
                </Button>
              </form>
            )}
          </Card>
        )}
      </Page>
    </>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  readonly field: ServiceField;
  readonly value: string | number | boolean | undefined;
  readonly onChange: (value: string | number | boolean | undefined) => void;
}) {
  const t = useTranslations('portal.service');
  const label = field.required ? field.label : `${field.label} ${t('optional')}`;
  const input = 'rounded-md border border-slate-300 px-3 py-2 text-base text-start';
  switch (field.type) {
    case 'NUMBER':
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{label}</span>
          <input
            type="number"
            className={input}
            min={field.min}
            max={field.max}
            required={field.required}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </label>
      );
    case 'CHOICE':
      return (
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 font-medium text-slate-700">{label}</legend>
          {field.options?.map((o) => (
            <label key={o.code} className="flex items-center gap-2">
              <input
                type="radio"
                name={field.code}
                value={o.code}
                required={field.required}
                checked={value === o.code}
                onChange={() => onChange(o.code)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>
      );
    case 'DATETIME':
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{label}</span>
          <input
            type="datetime-local"
            className={input}
            required={field.required}
            onChange={(e) =>
              onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)
            }
          />
        </label>
      );
    case 'BOOLEAN':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    default:
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{label}</span>
          <textarea
            className={input}
            rows={3}
            maxLength={field.maxLength}
            required={field.required}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
  }
}
