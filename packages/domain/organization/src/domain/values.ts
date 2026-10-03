import { HttpStatus } from '@nestjs/common';
import { AppError } from '@hotella/platform-i18n';

export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
/** Codes are uppercase, stable identifiers used in integrations and URLs. */
export function normalizeCode(input: string): string {
  const code = input.trim().toUpperCase().replace(/\s+/g, '_');
  if (!CODE_RE.test(code))
    throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
  return code;
}

export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Fonts a property may pick from (Product Identity: "typography configuration from approved fonts"). */
export const APPROVED_FONTS = [
  'Inter',
  'IBM Plex Sans',
  'IBM Plex Sans Arabic',
  'Noto Sans',
  'Noto Sans Arabic',
  'Cairo',
  'Tajawal',
  'Playfair Display',
  'Amiri',
] as const;

/** Location kinds that may have children. Rooms are leaves. */
export const CONTAINER_KINDS = new Set(['PROPERTY', 'BUILDING', 'FLOOR', 'AREA', 'PLANT', 'OTHER']);

/** Spec invariant 33 — not configurable through brand profiles (visibility is the platform attribution policy). */
export { PLANOVA_ATTRIBUTION as PLATFORM_ATTRIBUTION } from '@hotella/platform-settings';
