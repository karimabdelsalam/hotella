'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { BrandMark, ChevronIcon, cx, GlobeIcon, LOCALE_NAMES } from '@hotella/ui';
import { Link, usePathname, useRouter } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { logoUrl, useBrand } from '../lib/brand';

/** The hotel's logo and name (from branding) and the language switch; logical spacing so it mirrors in Arabic. */
export function TopBar({
  title,
  children,
}: {
  readonly title?: string | null;
  readonly children?: ReactNode;
}) {
  const t = useTranslations('portal.app');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { brand } = useBrand();
  const name = brand?.displayName || title || t('title');
  return (
    <header className="bg-brand text-white shadow-sm">
      <div className="mx-auto flex w-full max-w-xl items-center gap-3 px-4 py-3">
        <BrandMark name={name} logoUrl={logoUrl(brand)} onBrand />
        <span
          className="line-clamp-2 min-w-0 flex-1 text-base leading-tight font-bold sm:text-lg"
          data-testid="hotel-name"
        >
          {name}
        </span>
        {children}
        <label className="relative flex items-center">
          <GlobeIcon className="pointer-events-none absolute start-2 size-4 text-white/80" />
          <select
            aria-label={t('language')}
            className="appearance-none rounded-full bg-white/15 py-1.5 ps-7 pe-3 text-sm font-medium text-white hover:bg-white/25"
            value={locale}
            onChange={(e) => router.replace(pathname, { locale: e.target.value })}
          >
            {routing.locales.map((l) => (
              <option key={l} value={l} className="text-slate-900">
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

export function Page({ children }: { readonly children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-5 p-4">{children}</main>;
}

export function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      className={cx('rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5', className)}
    >
      {children}
    </section>
  );
}

/** A section title above a group of cards. */
export function SectionTitle({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <h2 id={id} className="px-1 text-sm font-bold text-slate-500">
      {children}
    </h2>
  );
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string; readonly hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-semibold text-slate-700">{label}</span>
      <input
        {...props}
        className="rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-start focus:border-[var(--brand-primary,#1f2937)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--brand-primary,#1f2937)_20%,transparent)] focus:outline-none"
      />
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      {children}
    </p>
  );
}

/** Back to the guest home; the chevron points to the start side in both directions. */
export function BackLink({ children }: { readonly children: ReactNode }) {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-1 self-start rounded-full px-2 py-1 text-sm font-medium text-slate-600 hover:bg-white"
    >
      <ChevronIcon className="size-4 rotate-180" />
      {children}
    </Link>
  );
}
