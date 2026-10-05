/**
 * Data egress policy (ADR-0018, Spec §42): deterministic code decides what a model provider may receive. Context parts
 * carry the data class of what they contain (the Phase 0 classification registry); parts above the provider's maximum
 * are dropped, and identifiers are masked before anything leaves the installation.
 */

export const DATA_CLASSES = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'SENSITIVE',
  'RESTRICTED',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export function classRank(c: DataClass): number {
  return DATA_CLASSES.indexOf(c);
}

/** RESTRICTED data (secrets, OTP material, payment data) never reaches any model, on-prem or not. */
export const NEVER_SENT: DataClass = 'RESTRICTED';

export interface EgressPolicy {
  readonly egress: 'ON_PREM' | 'EXTERNAL';
  readonly maxDataClass: DataClass;
}

/** Whether content of this class may be sent to a provider with this policy. */
export function mayReceive(policy: EgressPolicy, dataClass: DataClass): boolean {
  if (classRank(dataClass) >= classRank(NEVER_SENT)) return false;
  return classRank(dataClass) <= classRank(policy.maxDataClass);
}

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // E-mail addresses.
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  // Card-like digit runs (13–19 digits, spaces or dashes allowed).
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
  // Phone numbers: optional +, 8–15 digits with separators.
  [/\+?\d(?:[\s().-]?\d){7,14}/g, '[phone]'],
];

/**
 * Platform record ids (UUIDs) and ISO dates/times look like digit runs but are not personal identifiers; an agent's
 * tools need the ids back exactly, and dates carry meaning. They are set aside before masking and restored after.
 */
const KEEP =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi;
/** A placeholder without digits (so no pattern can match it): the index written in letters. */
const placeholder = (i: number) =>
  `\uE000${[...i.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join('')}\uE000`;

/** Masks identifiers a model never needs (phones, e-mails, card-like numbers); room numbers, ids and dates stay. */
export function maskIdentifiers(text: string): string {
  const kept: string[] = [];
  let out = text.replace(KEEP, (m) => placeholder(kept.push(m) - 1));
  for (const [re, label] of PATTERNS) out = out.replace(re, label);
  return out.replace(/\uE000([a-z]+)\uE000/g, (_, letters: string) => {
    const index = parseInt(
      [...letters].map((c) => (c.charCodeAt(0) - 97).toString(26)).join(''),
      26,
    );
    return kept[index] ?? '';
  });
}

export interface ClassifiedPart {
  readonly text: string;
  readonly dataClass: DataClass;
}

/**
 * The text a provider may see: parts it may not receive are left out (and counted), the rest are masked when they leave
 * the installation.
 */
export function applyEgress(
  policy: EgressPolicy,
  parts: readonly ClassifiedPart[],
): { readonly kept: string[]; readonly dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const p of parts) {
    if (!mayReceive(policy, p.dataClass)) {
      dropped++;
      continue;
    }
    kept.push(policy.egress === 'EXTERNAL' ? maskIdentifiers(p.text) : p.text);
  }
  return { kept, dropped };
}

/**
 * Guest speech (ADR-0025, Q22): audio goes to an external provider only when the hotel approved cloud speech; providers
 * on Planova-operated infrastructure are always allowed (the data-class policy still applies to both).
 */
export function speechAllowed(
  egress: EgressPolicy['egress'],
  hotelApproval: { readonly enabled: boolean },
): boolean {
  return egress !== 'EXTERNAL' || hotelApproval.enabled;
}
