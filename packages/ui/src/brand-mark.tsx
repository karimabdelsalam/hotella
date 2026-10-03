import { cx } from './primitives';

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-16 text-xl',
};

/** Up to two initials of the hotel's name (first letters of its first two words), for when there is no logo. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * The hotel's mark: its uploaded logo on a white tile, or its initials on the brand colour. Nothing hotel-specific is
 * built in (CLAUDE.md rule 15): name and logo come from the resolved brand.
 */
export function BrandMark({
  name,
  logoUrl,
  size = 'md',
  onBrand = false,
  className,
}: {
  readonly name: string;
  readonly logoUrl?: string | null;
  readonly size?: keyof typeof SIZE;
  /** Sitting on a brand-coloured surface: the initials get a translucent tile instead of the brand colour. */
  readonly onBrand?: boolean;
  readonly className?: string;
}) {
  if (logoUrl)
    return (
      <span
        className={cx(
          'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1 shadow-sm ring-1 ring-black/5',
          SIZE[size],
          className,
        )}
      >
        <img src={logoUrl} alt={name} className="max-h-full max-w-full object-contain" />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-xl font-bold text-white shadow-sm ring-1 ring-white/20',
        onBrand ? 'bg-white/15' : 'bg-[var(--brand-primary,#1f2937)]',
        SIZE[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
