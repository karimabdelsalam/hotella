import { z } from 'zod';
import { parseClock, wallClock } from '@hotella/platform-time';

/**
 * Service rules (Spec §7, BUILD_PLAN §9.2): required fields, eligibility, availability and the automation policy of a
 * service version. Everything here is deterministic code (CLAUDE.md rule 11); labels are translations, never stored
 * in these rules (rule 7).
 */

export const SERVICE_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const FIELD_CODE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const OPTION_CODE_RE = /^[A-Z0-9][A-Z0-9_]{0,31}$/;

export const TEXT_MAX = 500;

const fieldBase = { code: z.string().regex(FIELD_CODE_RE), required: z.boolean().default(false) };

export const fieldSchema = z.discriminatedUnion('type', [
  z.object({
    ...fieldBase,
    type: z.literal('TEXT'),
    maxLength: z.number().int().min(1).max(TEXT_MAX).default(TEXT_MAX),
  }),
  z.object({
    ...fieldBase,
    type: z.literal('NUMBER'),
    min: z.number().int().min(0).default(1),
    max: z.number().int().min(1).max(1000).default(10),
  }),
  z.object({
    ...fieldBase,
    type: z.literal('CHOICE'),
    options: z.array(z.string().regex(OPTION_CODE_RE)).min(1).max(20),
  }),
  z.object({ ...fieldBase, type: z.literal('DATETIME') }),
  z.object({ ...fieldBase, type: z.literal('BOOLEAN') }),
]);
export type FieldDefinition = z.infer<typeof fieldSchema>;

export const requiredFieldsSchema = z
  .array(fieldSchema)
  .max(12)
  .refine(
    (fields) => new Set(fields.map((f) => f.code)).size === fields.length,
    'field codes must be unique',
  );

export const STAY_STATUSES = ['EXPECTED', 'IN_HOUSE', 'CHECKED_OUT'] as const;

export const eligibilitySchema = z.object({
  /** Stay states in which the service can be requested (default: in house only). */
  stayStatuses: z.array(z.enum(STAY_STATUSES)).min(1).default(['IN_HOUSE']),
  partyRoles: z
    .array(z.enum(['PRIMARY', 'ACCOMPANYING']))
    .min(1)
    .default(['PRIMARY', 'ACCOMPANYING']),
  /** Empty: every room type. */
  roomTypeIds: z.array(z.uuid()).max(100).default([]),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;

const clock = z.string().refine((v) => parseClock(v) !== null, 'expected HH:MM');

export const availabilitySchema = z.object({
  /** Opening hours in the property's time zone; empty means always. Days: 0 = Sunday … 6 = Saturday. */
  hours: z
    .array(
      z
        .object({ days: z.array(z.number().int().min(0).max(6)).min(1), from: clock, to: clock })
        .refine((h) => parseClock(h.from)! < parseClock(h.to)!, 'from must be before to'),
    )
    .max(14)
    .default([]),
  /** A scheduled request must be at least this far ahead. */
  leadTimeMinutes: z.number().int().min(0).max(10_080).default(0),
  /** Whether the guest may pick a time (`requested_for_at`); otherwise the request is for now. */
  allowScheduling: z.boolean().default(false),
  /** How many requests of this service one stay may make per property day (null: no limit). */
  maxPerStayPerDay: z.number().int().min(1).max(100).nullable().default(null),
});
export type Availability = z.infer<typeof availabilitySchema>;

/** What AI may do with this service (enforced from Phase 6; stored and versioned now). */
export const automationPolicySchema = z.object({
  aiMayCreate: z.boolean().default(true),
  aiRequiresConfirmation: z.boolean().default(false),
});
export type AutomationPolicy = z.infer<typeof automationPolicySchema>;

/** Display only (charging is Phase 10). Minor units avoid float money. */
export const priceSchema = z
  .object({ amountMinor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/) })
  .nullable();
export type Price = z.infer<typeof priceSchema>;

// ---- evaluation ----

export interface EligibilityContext {
  readonly stayStatus: string;
  readonly partyRole: 'PRIMARY' | 'ACCOMPANYING';
  readonly roomTypeId: string | null;
}

/** Null when eligible; otherwise the reason code (locale key suffix under `catalog.request.`). */
export function eligibilityProblem(rules: Eligibility, ctx: EligibilityContext): string | null {
  if (!(rules.stayStatuses as readonly string[]).includes(ctx.stayStatus))
    return 'stay_not_eligible';
  if (!rules.partyRoles.includes(ctx.partyRole)) return 'guest_not_eligible';
  if (
    rules.roomTypeIds.length > 0 &&
    (!ctx.roomTypeId || !rules.roomTypeIds.includes(ctx.roomTypeId))
  )
    return 'room_not_eligible';
  return null;
}

/** Whether `at` falls into the opening hours (property time zone); no hours means always open. */
export function isOpenAt(availability: Availability, at: Date, timeZone: string): boolean {
  if (availability.hours.length === 0) return true;
  const w = wallClock(at, timeZone);
  const minute = w.hour * 60 + w.minute;
  return availability.hours.some(
    (h) =>
      h.days.includes(w.weekday) && minute >= parseClock(h.from)! && minute < parseClock(h.to)!,
  );
}

/**
 * Null when a request for `requestedFor` (null = now) is possible at `now`; otherwise the reason code. The daily cap
 * counts the stay's requests of this service made on the same property day (`sameDayCount`).
 */
export function availabilityProblem(
  availability: Availability,
  input: {
    readonly now: Date;
    readonly requestedFor: Date | null;
    readonly timeZone: string;
    readonly sameDayCount: number;
  },
): string | null {
  if (input.requestedFor && !availability.allowScheduling) return 'scheduling_not_allowed';
  const at = input.requestedFor ?? input.now;
  if (
    input.requestedFor &&
    input.requestedFor.getTime() < input.now.getTime() + availability.leadTimeMinutes * 60_000
  )
    return 'lead_time';
  if (!isOpenAt(availability, at, input.timeZone)) return 'closed';
  if (availability.maxPerStayPerDay !== null && input.sameDayCount >= availability.maxPerStayPerDay)
    return 'daily_limit';
  return null;
}

export type FieldValues = Record<string, string | number | boolean>;

export class FieldError extends Error {
  constructor(
    readonly field: string,
    readonly problem: 'required' | 'invalid' | 'unknown',
  ) {
    super(`field ${field}: ${problem}`);
    this.name = 'FieldError';
  }
}

/** Validates and normalizes submitted values against the version's fields; unknown fields are refused. */
export function validateFields(
  fields: readonly FieldDefinition[],
  values: Record<string, unknown>,
): FieldValues {
  const out: FieldValues = {};
  const known = new Set(fields.map((f) => f.code));
  for (const key of Object.keys(values)) if (!known.has(key)) throw new FieldError(key, 'unknown');
  for (const f of fields) {
    const v = values[f.code];
    if (v === undefined || v === null || v === '') {
      if (f.required) throw new FieldError(f.code, 'required');
      continue;
    }
    switch (f.type) {
      case 'TEXT': {
        if (typeof v !== 'string') throw new FieldError(f.code, 'invalid');
        const text = v.trim();
        if (text.length > f.maxLength) throw new FieldError(f.code, 'invalid');
        if (text.length === 0) {
          if (f.required) throw new FieldError(f.code, 'required');
          continue;
        }
        out[f.code] = text;
        break;
      }
      case 'NUMBER':
        if (typeof v !== 'number' || !Number.isInteger(v) || v < f.min || v > f.max)
          throw new FieldError(f.code, 'invalid');
        out[f.code] = v;
        break;
      case 'CHOICE':
        if (typeof v !== 'string' || !f.options.includes(v))
          throw new FieldError(f.code, 'invalid');
        out[f.code] = v;
        break;
      case 'DATETIME': {
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/[zZ]|[+-]\d\d:\d\d$/.test(v))
          throw new FieldError(f.code, 'invalid');
        out[f.code] = new Date(v).toISOString();
        break;
      }
      case 'BOOLEAN':
        if (typeof v !== 'boolean') throw new FieldError(f.code, 'invalid');
        out[f.code] = v;
        break;
    }
  }
  return out;
}

/** The guest's own words (TEXT fields): cleared on anonymization, never copied into events, logs or titles. */
export function freeTextFieldCodes(fields: readonly FieldDefinition[]): string[] {
  return fields.filter((f) => f.type === 'TEXT').map((f) => f.code);
}

/**
 * Translation fallback (BUILD_PLAN §9.2): the requested locale, its language (`ar-EG` → `ar`), the property default,
 * then `en`. Undefined when nothing usable exists.
 */
export function pickTranslation<T extends { readonly locale: string }>(
  rows: readonly T[],
  locale: string,
  propertyDefault: string,
): T | undefined {
  const chain = [
    locale,
    locale.split('-')[0]!,
    propertyDefault,
    propertyDefault.split('-')[0]!,
    'en',
  ];
  for (const l of chain) {
    const hit = rows.find((r) => r.locale === l);
    if (hit) return hit;
  }
  return undefined;
}
