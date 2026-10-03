import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** Class helper (no dependency): joins truthy class names. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

const BUTTON: Record<'primary' | 'secondary' | 'danger' | 'ghost', string> = {
  primary: 'bg-[var(--brand-primary,#0f4c81)] text-white hover:opacity-90',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
  danger: 'bg-red-700 text-white hover:bg-red-800',
  ghost: 'text-slate-700 hover:bg-slate-100',
};

/** Buttons use logical padding (`px-*` is symmetric; icons use `me-*`/`ms-*`), so they mirror in RTL by themselves. */
export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: keyof typeof BUTTON }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON[variant],
        className,
      )}
    />
  );
}

const TONE: Record<'neutral' | 'info' | 'warning' | 'success' | 'danger', string> = {
  neutral: 'bg-slate-100 text-slate-700',
  info: 'bg-sky-100 text-sky-800',
  warning: 'bg-amber-100 text-amber-900',
  success: 'bg-emerald-100 text-emerald-800',
  danger: 'bg-red-100 text-red-800',
};

export function Badge({
  tone = 'neutral',
  children,
}: {
  readonly tone?: keyof typeof TONE;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}
