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

/** Masks identifiers a model never needs (phones, e-mails, card-like numbers); room numbers stay readable. */
export function maskIdentifiers(text: string): string {
  let out = text;
  for (const [re, label] of PATTERNS) out = out.replace(re, label);
  return out;
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
