'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { cx } from '@hotella/ui';
import { usePathname, useRouter } from '../i18n/navigation';
import { routing } from '../i18n/routing';
import { useBrand } from '../lib/brand';

const NAMES: Record<string, string> = { en: 'English', ar: 'العربية' };

/** The hotel's name (from branding) and the language switch; logical spacing so it mirrors in Arabic. */
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
  return (
    <header className="flex items-center gap-3 bg-[var(--brand-primary,#1f2937)] px-4 py-3 text-white">
      <span className="truncate font-semibold" data-testid="hotel-name">
        {brand?.displayName || title || t('title')}
      </span>
      <div className="ms-auto flex items-center gap-2">
        {children}
        <select
          aria-label={t('language')}
          className="rounded bg-white/15 px-2 py-1 text-sm text-white"
          value={locale}
          onChange={(e) => router.replace(pathname, { locale: e.target.value })}
        >
          {routing.locales.map((l) => (
            <option key={l} value={l} className="text-slate-900">
              {NAMES[l] ?? l}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}

export function Page({ children }: { readonly children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-4">{children}</main>;
}

export function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cx('rounded-lg bg-white p-4 shadow-sm', className)}>{children}</section>
  );
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string; readonly hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input
        {...props}
        className="rounded-md border border-slate-300 px-3 py-2 text-base text-start focus:border-[var(--brand-primary,#1f2937)] focus:outline-none"
      />
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-red-700">
      {children}
    </p>
  );
}
