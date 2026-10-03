'use client';

import { useTranslations } from 'next-intl';
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { BrandMark, Button, ImageIcon } from '@hotella/ui';
import { Header } from './header';
import { useRouter } from '../i18n/navigation';
import { logoUrl, useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type { Me, PropertyBrand, PropertySummary } from '../lib/types';

const MAX_LOGO_BYTES = 512 * 1024;
const HEX = /^#[0-9a-f]{6}$/i;

function canManage(me: Me, propertyId: string): boolean {
  return me.memberships.some(
    (m) =>
      (m.propertyId === null || m.propertyId === propertyId) &&
      m.permissions.includes('branding.manage'),
  );
}

/**
 * The hotel's own brand for its managers (Spec Product Identity): name, colour and logo, with a live preview of the
 * guest header. What is left empty is inherited from the hotel group. The "Powered by Planova" line is not a brand
 * setting and is not offered here (CLAUDE.md rule 15).
 */
export function BrandingApp() {
  const t = useTranslations('staff.brand');
  const tStaff = useTranslations('staff');
  const session = useSession();
  const router = useRouter();
  const { show: showBrand, refresh: refreshBrand } = useStaffBrand();
  const [properties, setProperties] = useState<PropertySummary[] | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [data, setData] = useState<PropertyBrand | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  useEffect(() => showBrand(propertyId), [propertyId, showBrand]);

  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );

  useEffect(() => {
    if (session.state !== 'signed-in') return;
    void (async () => {
      try {
        const me = await session.api<Me>('/me');
        const all = await session.api<PropertySummary[]>('/properties');
        const allowed = all.filter((p) => canManage(me, p.id));
        setProperties(allowed);
        setPropertyId((current) => current ?? allowed[0]?.id ?? null);
      } catch (e) {
        fail(e);
      }
    })();
  }, [session, fail]);

  const accept = useCallback((b: PropertyBrand) => {
    setData(b);
    setName(b.profile?.displayName ?? '');
    setColor(b.profile?.primaryColor ?? '');
  }, []);

  useEffect(() => {
    if (!propertyId || session.state !== 'signed-in') return;
    session.api<PropertyBrand>(`/properties/${propertyId}/branding`).then(accept).catch(fail);
  }, [session, propertyId, accept, fail]);

  async function run(action: () => Promise<PropertyBrand>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      accept(await action());
      refreshBrand();
      setNotice(done);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void run(
      () =>
        session.api<PropertyBrand>(`/properties/${propertyId}/branding`, {
          method: 'PATCH',
          body: { displayName: name.trim() || null, primaryColor: HEX.test(color) ? color : null },
        }),
      t('saved'),
    );
  }

  function upload(picked: File | undefined) {
    if (file.current) file.current.value = '';
    if (!picked) return;
    if (picked.size > MAX_LOGO_BYTES) {
      setNotice(null);
      setError(t('too_large'));
      return;
    }
    void run(
      () =>
        session.api<PropertyBrand>(`/properties/${propertyId}/branding/logo`, {
          method: 'PUT',
          file: picked,
        }),
      t('logo_saved'),
    );
  }

  if (session.state !== 'signed-in') return <Header />;
  const resolved = data?.resolved ?? null;
  const previewName = name.trim() || resolved?.displayName || '';
  const previewColor = HEX.test(color) ? color : (resolved?.primaryColor ?? '#1f2937');
  return (
    <>
      <Header />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 text-sm">
        <h1 className="text-base font-bold">{t('title')}</h1>
        {properties && properties.length > 1 && (
          <select
            aria-label={tStaff('inbox.property')}
            className="rounded-full border border-slate-300 bg-white px-3 py-1"
            value={propertyId ?? ''}
            onChange={(e) => setPropertyId(e.target.value)}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
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
      {properties && properties.length === 0 ? (
        <p className="p-6 text-sm text-slate-600">{t('no_permission')}</p>
      ) : (
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-4">
            <section
              aria-labelledby="logo-title"
              className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5"
            >
              <h2 id="logo-title" className="font-bold">
                {t('logo')}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{t('logo_hint')}</p>
              <div className="mt-4 flex flex-wrap items-center gap-4">
                <BrandMark name={previewName} logoUrl={logoUrl(resolved)} size="lg" />
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--brand-primary,#0f4c81)] px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90">
                    <ImageIcon className="size-4" />
                    {t('upload')}
                    <input
                      ref={file}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      disabled={busy || !propertyId}
                      data-testid="logo-file"
                      onChange={(e) => upload(e.target.files?.[0])}
                    />
                  </label>
                  {data?.profile?.logoAssetKey && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            session.api<PropertyBrand>(`/properties/${propertyId}/branding/logo`, {
                              method: 'DELETE',
                            }),
                          t('logo_removed'),
                        )
                      }
                    >
                      {t('remove_logo')}
                    </Button>
                  )}
                </div>
              </div>
            </section>
            <form
              onSubmit={save}
              aria-labelledby="identity-title"
              className="flex flex-col gap-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5"
            >
              <h2 id="identity-title" className="font-bold">
                {t('identity')}
              </h2>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-semibold text-slate-700">{t('name')}</span>
                <input
                  className="rounded-xl border border-slate-300 px-3.5 py-2.5 text-base text-start"
                  value={name}
                  maxLength={200}
                  placeholder={resolved?.displayName ?? ''}
                  onChange={(e) => setName(e.target.value)}
                />
                <span className="text-xs text-slate-500">{t('inherit_hint')}</span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-semibold text-slate-700">{t('color')}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('color')}
                    className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
                    value={previewColor}
                    onChange={(e) => setColor(e.target.value)}
                  />
                  <input
                    dir="ltr"
                    className="w-32 rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm"
                    value={color}
                    placeholder={resolved?.primaryColor ?? ''}
                    maxLength={7}
                    onChange={(e) => setColor(e.target.value)}
                  />
                  {color && (
                    <Button type="button" variant="ghost" onClick={() => setColor('')}>
                      {t('reset')}
                    </Button>
                  )}
                </span>
              </label>
              <div>
                <Button type="submit" disabled={busy || !propertyId}>
                  {t('save')}
                </Button>
              </div>
            </form>
          </div>
          <aside aria-labelledby="preview-title" className="flex flex-col gap-2">
            <h2 id="preview-title" className="px-1 text-sm font-bold text-slate-500">
              {t('preview')}
            </h2>
            <div
              className="overflow-hidden rounded-2xl bg-slate-100 shadow-sm ring-1 ring-slate-900/5"
              style={{ '--brand-primary': previewColor } as CSSProperties}
              data-testid="brand-preview"
            >
              <div className="bg-brand flex items-center gap-2.5 px-4 py-3 text-white">
                <BrandMark name={previewName} logoUrl={logoUrl(resolved)} onBrand />
                <span className="truncate text-lg font-bold">{previewName}</span>
              </div>
              <div className="flex flex-col gap-3 p-4">
                <div className="rounded-2xl bg-white p-4 shadow-sm">
                  <p className="text-lg font-bold">{t('preview_welcome')}</p>
                  <span className="bg-brand-soft text-brand mt-2 inline-block rounded-full px-3 py-0.5 text-sm font-bold">
                    {t('preview_room')}
                  </span>
                </div>
                <Button type="button" tabIndex={-1}>
                  {t('preview_button')}
                </Button>
              </div>
            </div>
          </aside>
        </main>
      )}
    </>
  );
}
