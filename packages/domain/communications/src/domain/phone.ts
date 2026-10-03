/**
 * Phone numbers as channel identifiers (Spec §18.3): normalized to E.164 so one person has one identity per channel,
 * whatever way the number was typed. Deterministic and dependency-free: international forms (`+`, `00`) are kept;
 * national forms need the property's country. Anything ambiguous is refused, never guessed (CLAUDE.md rule 16).
 */

/** Country calling codes and trunk prefixes of the markets Hotella serves first; extend as properties open. */
const CALLING_CODES: Readonly<Record<string, { readonly code: string; readonly trunk: string }>> = {
  EG: { code: '20', trunk: '0' },
  SA: { code: '966', trunk: '0' },
  AE: { code: '971', trunk: '0' },
  JO: { code: '962', trunk: '0' },
  KW: { code: '965', trunk: '' },
  QA: { code: '974', trunk: '' },
  BH: { code: '973', trunk: '' },
  OM: { code: '968', trunk: '' },
  LB: { code: '961', trunk: '0' },
  MA: { code: '212', trunk: '0' },
  TN: { code: '216', trunk: '' },
  TR: { code: '90', trunk: '0' },
  GB: { code: '44', trunk: '0' },
  DE: { code: '49', trunk: '0' },
  FR: { code: '33', trunk: '0' },
  IT: { code: '39', trunk: '' },
  ES: { code: '34', trunk: '' },
  US: { code: '1', trunk: '1' },
};

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** `+201001234567` for `0100 123 4567` in Egypt, `+20 100-123-4567` or `0020 100 123 4567`; null when not a number. */
export function toE164(raw: string, defaultCountry?: string | null): string | null {
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  let candidate: string;
  if (trimmed.startsWith('+')) candidate = `+${digits}`;
  else if (digits.startsWith('00')) candidate = `+${digits.slice(2)}`;
  else {
    const country = defaultCountry ? CALLING_CODES[defaultCountry.toUpperCase()] : undefined;
    if (!country) return null;
    const national =
      country.trunk && digits.startsWith(country.trunk)
        ? digits.slice(country.trunk.length)
        : digits;
    candidate = `+${country.code}${national}`;
  }
  return E164_RE.test(candidate) ? candidate : null;
}

export function isE164(value: string): boolean {
  return E164_RE.test(value);
}

/** For staff screens and logs-free UIs: `+20*******567`. */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '*'.repeat(e164.length);
  return `${e164.slice(0, 3)}${'*'.repeat(e164.length - 6)}${e164.slice(-3)}`;
}
