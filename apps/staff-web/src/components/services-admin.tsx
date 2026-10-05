'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, cx, LOCALE_NAMES, LOCALES } from '@hotella/ui';
import { Header } from './header';
import { card, field, label, type Run } from './restaurant-common';
import { useRouter } from '../i18n/navigation';
import { permissionsAt, usePropertiesWith } from '../lib/access';
import { useStaffBrand } from '../lib/brand';
import { ApiError, useSession } from '../lib/session';
import type {
  CatalogCategory,
  CatalogService,
  DepartmentSummary,
  ServiceTranslation,
  ServiceVersionView,
} from '../lib/types';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
type Texts = Record<string, { name: string; shortDescription: string }>;

/** A text of a version in a language: the language asked → English → the code. */
function nameIn(v: ServiceVersionView | null, locale: string, fallback: string): string {
  const tr = v?.translations ?? [];
  return (
    tr.find((x) => x.locale === locale)?.name ?? tr.find((x) => x.locale === 'en')?.name ?? fallback
  );
}

/**
 * The guest services of a property (Spec §7, BUILD_PLAN pilot P.3): start from the starter catalog, add a service,
 * change a service through a draft (department, priority, shown to guests, names in every language) and publish it —
 * published versions never change (rule 9) — or retire it. Shown with `catalog.manage`; publishing needs
 * `catalog.publish`.
 */
export function ServicesAdminApp() {
  const t = useTranslations('staff.services');
  const tStaff = useTranslations('staff');
  const locale = useLocale();
  const session = useSession();
  const router = useRouter();
  const { me, properties, propertyId, setPropertyId, failed } = usePropertiesWith('catalog.manage');
  const { show: showBrand } = useStaffBrand();
  const [services, setServices] = useState<CatalogService[] | null>(null);
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (session.state === 'anonymous') router.replace('/login');
  }, [session.state, router]);
  useEffect(() => showBrand(propertyId), [propertyId, showBrand]);
  const fail = useCallback(
    (e: unknown) => setError(e instanceof ApiError && e.detail ? e.detail : tStaff('inbox.error')),
    [tStaff],
  );
  useEffect(() => {
    if (failed) fail(failed);
  }, [failed, fail]);
  const canPublish = useMemo(
    () => !!me && !!propertyId && permissionsAt(me, propertyId).has('catalog.publish'),
    [me, propertyId],
  );

  const load = useCallback(async () => {
    if (!propertyId) return;
    const [s, c, d] = await Promise.all([
      session.api<CatalogService[]>(`/catalog/services?propertyId=${propertyId}`),
      session.api<CatalogCategory[]>(`/catalog/categories?propertyId=${propertyId}`),
      session.api<DepartmentSummary[]>(`/properties/${propertyId}/departments`),
    ]);
    setServices(s);
    setCategories(c);
    setDepartments(d);
  }, [session, propertyId]);
  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  const run: Run = async (action, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const categoryName = (id: string) => {
    const c = categories.find((x) => x.id === id);
    const tr = c?.translations ?? [];
    return (
      tr.find((x) => x.locale === locale)?.name ??
      tr.find((x) => x.locale === 'en')?.name ??
      c?.code ??
      ''
    );
  };
  const current = services?.find((s) => s.id === selected) ?? null;

  if (session.state !== 'signed-in') return <Header />;
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
        {propertyId && (
          <Button
            className="ms-auto"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await session.api<{ created: string[]; skipped: string[] }>(
                  `/properties/${propertyId}/catalog/starter`,
                  { method: 'POST', body: {} },
                );
                await load();
                setNotice(
                  t('starter_done', { created: r.created.length, skipped: r.skipped.length }),
                );
              })
            }
          >
            {t('starter')}
          </Button>
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
      {properties && properties.length === 0 && (
        <p className="p-6 text-sm text-slate-600">{t('no_property')}</p>
      )}
      {propertyId && services && (
        <main className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
          <section className={card} aria-labelledby="services-list">
            <h2 id="services-list" className="mb-3 font-semibold">
              {t('list', { count: services.length })}
            </h2>
            {services.length === 0 && <p className="text-sm text-slate-500">{t('empty')}</p>}
            <ul className="divide-y divide-slate-100">
              {services.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={selected === s.id}
                    data-service={s.code}
                    onClick={() => setSelected(s.id)}
                    className={cx(
                      'flex w-full flex-wrap items-center gap-2 px-2 py-2.5 text-start hover:bg-slate-50',
                      selected === s.id && 'bg-brand-soft',
                    )}
                  >
                    <span className="font-semibold">
                      {nameIn(s.published ?? s.draft, locale, s.code)}
                    </span>
                    <span className="text-xs text-slate-500">{categoryName(s.categoryId)}</span>
                    <span className="ms-auto flex gap-1">
                      {s.draft && <Badge tone="warning">{t('has_draft')}</Badge>}
                      {s.published && !s.published.guestVisible && (
                        <Badge tone="neutral">{t('staff_only')}</Badge>
                      )}
                      <Badge tone={s.status === 'ACTIVE' ? 'success' : 'neutral'}>
                        {t(`status.${s.status}`)}
                      </Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <div className="flex flex-col gap-4">
            {current && (
              <ServiceEditor
                key={`${current.id}:${current.version}:${current.draft?.version ?? 0}`}
                service={current}
                departments={departments}
                canPublish={canPublish}
                busy={busy}
                run={run}
                onChanged={load}
              />
            )}
            <NewService
              propertyId={propertyId}
              categories={categories}
              categoryName={categoryName}
              departments={departments}
              busy={busy}
              run={run}
              onCreated={async (id) => {
                await load();
                setSelected(id);
              }}
            />
          </div>
        </main>
      )}
    </>
  );
}

function ServiceEditor({
  service,
  departments,
  canPublish,
  busy,
  run,
  onChanged,
}: {
  readonly service: CatalogService;
  readonly departments: readonly DepartmentSummary[];
  readonly canPublish: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onChanged: () => Promise<void>;
}) {
  const t = useTranslations('staff.services');
  const locale = useLocale();
  const session = useSession();
  const draft = service.draft;
  const shown = draft ?? service.published;
  const [form, setForm] = useState(() => ({
    departmentCode: shown?.departmentCode ?? departments[0]?.code ?? '',
    priority: shown?.priority ?? 'NORMAL',
    guestVisible: shown?.guestVisible ?? true,
    texts: Object.fromEntries(
      LOCALES.map((l) => {
        const tr = shown?.translations.find((x) => x.locale === l);
        return [l, { name: tr?.name ?? '', shortDescription: tr?.shortDescription ?? '' }];
      }),
    ) as Texts,
  }));

  /** The draft's translations with the edited names; other texts (field labels, hints) are kept as they are. */
  const translations = (): ServiceTranslation[] =>
    LOCALES.filter((l) => form.texts[l]!.name.trim()).map((l) => {
      const existing = draft?.translations.find((x) => x.locale === l) ?? { locale: l };
      return {
        ...existing,
        locale: l,
        name: form.texts[l]!.name.trim(),
        shortDescription: form.texts[l]!.shortDescription.trim() || null,
      };
    });

  return (
    <section className={cx(card, 'flex flex-col gap-3')} aria-labelledby="service-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="service-title" className="font-semibold">
          {nameIn(shown, locale, service.code)}
        </h2>
        <code className="text-xs text-slate-500" dir="ltr">
          {service.code}
        </code>
        {service.published && (
          <Badge tone="success">{t('published_v', { n: service.published.versionNo })}</Badge>
        )}
        {draft && <Badge tone="warning">{t('draft_v', { n: draft.versionNo })}</Badge>}
      </div>
      {!draft && (
        <p className="text-sm text-slate-600">
          {t('published_hint')}{' '}
          <Button
            variant="secondary"
            disabled={busy || service.status !== 'ACTIVE'}
            onClick={() =>
              void run(async () => {
                await session.api(`/catalog/services/${service.id}/drafts`, { method: 'POST' });
                await onChanged();
              })
            }
          >
            {t('edit')}
          </Button>
        </p>
      )}
      <fieldset disabled={!draft || busy} className="flex flex-col gap-2">
        <legend className="sr-only">{t('details')}</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className={label}>
            {t('department')}
            <select
              className={field}
              value={form.departmentCode}
              onChange={(e) => setForm({ ...form, departmentCode: e.target.value })}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t('priority')}
            <select
              className={field}
              value={form.priority}
              onChange={(e) =>
                setForm({ ...form, priority: e.target.value as (typeof PRIORITIES)[number] })
              }
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority_${p}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.guestVisible}
            onChange={(e) => setForm({ ...form, guestVisible: e.target.checked })}
          />
          {t('guest_visible')}
        </label>
        {LOCALES.map((l) => (
          <div key={l} className="grid grid-cols-2 gap-2" lang={l} dir={l === 'ar' ? 'rtl' : 'ltr'}>
            <label className={label}>
              {t('name_in', { language: LOCALE_NAMES[l] })}
              <input
                className={field}
                required={l === 'en'}
                value={form.texts[l]!.name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    texts: { ...form.texts, [l]: { ...form.texts[l]!, name: e.target.value } },
                  })
                }
              />
            </label>
            <label className={label}>
              {t('short_in', { language: LOCALE_NAMES[l] })}
              <input
                className={field}
                value={form.texts[l]!.shortDescription}
                onChange={(e) =>
                  setForm({
                    ...form,
                    texts: {
                      ...form.texts,
                      [l]: { ...form.texts[l]!, shortDescription: e.target.value },
                    },
                  })
                }
              />
            </label>
          </div>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {draft && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await session.api(`/catalog/versions/${draft.id}`, {
                  method: 'PATCH',
                  body: {
                    version: draft.version,
                    departmentCode: form.departmentCode,
                    priority: form.priority,
                    guestVisible: form.guestVisible,
                    translations: translations(),
                  },
                });
                await onChanged();
              }, t('saved'))
            }
          >
            {t('save_draft')}
          </Button>
        )}
        {draft && canPublish && (
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await session.api(`/catalog/versions/${draft.id}/publish`, {
                  method: 'POST',
                  body: { version: draft.version },
                });
                await onChanged();
              }, t('published'))
            }
          >
            {t('publish')}
          </Button>
        )}
        <Button
          className="ms-auto"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await session.api(`/catalog/services/${service.id}`, {
                method: 'PATCH',
                body: {
                  version: service.version,
                  status: service.status === 'ACTIVE' ? 'RETIRED' : 'ACTIVE',
                },
              });
              await onChanged();
            }, t('saved'))
          }
        >
          {service.status === 'ACTIVE' ? t('retire') : t('reactivate')}
        </Button>
      </div>
    </section>
  );
}

function NewService({
  propertyId,
  categories,
  categoryName,
  departments,
  busy,
  run,
  onCreated,
}: {
  readonly propertyId: string;
  readonly categories: readonly CatalogCategory[];
  readonly categoryName: (id: string) => string;
  readonly departments: readonly DepartmentSummary[];
  readonly busy: boolean;
  readonly run: Run;
  readonly onCreated: (id: string) => Promise<void>;
}) {
  const t = useTranslations('staff.services');
  const locale = useLocale();
  const session = useSession();
  const [form, setForm] = useState({ code: '', name: '', categoryId: '', departmentCode: '' });
  if (categories.length === 0) return null;
  return (
    <form
      className={cx(card, 'flex flex-col gap-2')}
      aria-labelledby="new-service-title"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const created = await session.api<CatalogService>('/catalog/services', {
            method: 'POST',
            body: {
              propertyId,
              code: form.code.trim().toUpperCase().replace(/\s+/g, '_'),
              categoryId: form.categoryId || categories[0]!.id,
              draft: {
                departmentCode: form.departmentCode || departments[0]?.code,
                translations: [{ locale, name: form.name.trim() }],
              },
            },
          });
          setForm({ code: '', name: '', categoryId: '', departmentCode: '' });
          await onCreated(created.id);
        }, t('created'));
      }}
    >
      <h2 id="new-service-title" className="font-semibold">
        {t('new')}
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <label className={label}>
          {t('code')}
          <input
            required
            dir="ltr"
            pattern="[A-Za-z][A-Za-z0-9_ ]{1,63}"
            className={field}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </label>
        <label className={label}>
          {t('name')}
          <input
            required
            className={field}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className={label}>
          {t('category')}
          <select
            className={field}
            value={form.categoryId || categories[0]!.id}
            onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {categoryName(c.id)}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t('department')}
          <select
            className={field}
            value={form.departmentCode || departments[0]?.code || ''}
            onChange={(e) => setForm({ ...form, departmentCode: e.target.value })}
          >
            {departments.map((d) => (
              <option key={d.id} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Button type="submit" variant="secondary" disabled={busy}>
        {t('add')}
      </Button>
    </form>
  );
}
