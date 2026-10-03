import { z } from 'zod';

/**
 * Controlled flexible properties of an asset type (Spec §10.2): a small, closed field language (text, number, boolean,
 * choice), never free JSON. Validation is deterministic; unknown keys are refused so typos do not become data.
 */

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const propertyFieldSchema = z.discriminatedUnion('type', [
  z.object({
    key: z.string().regex(KEY),
    type: z.literal('TEXT'),
    required: z.boolean().default(false),
    maxLength: z.number().int().min(1).max(500).default(200),
  }),
  z.object({
    key: z.string().regex(KEY),
    type: z.literal('NUMBER'),
    required: z.boolean().default(false),
    unit: z.string().trim().min(1).max(16).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    key: z.string().regex(KEY),
    type: z.literal('BOOLEAN'),
    required: z.boolean().default(false),
  }),
  z.object({
    key: z.string().regex(KEY),
    type: z.literal('CHOICE'),
    required: z.boolean().default(false),
    options: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
      .min(1)
      .max(50),
  }),
]);
export type PropertyField = z.infer<typeof propertyFieldSchema>;

export const propertiesSchema = z
  .array(propertyFieldSchema)
  .max(40)
  .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, {
    message: 'duplicate key',
  });

export type PropertyValue = string | number | boolean;

export interface PropertyProblem {
  readonly key: string;
  readonly problem: 'REQUIRED' | 'UNKNOWN' | 'TYPE' | 'RANGE' | 'TOO_LONG' | 'NOT_AN_OPTION';
}

/** Problems of an asset's properties against its type's fields; empty when they are valid. */
export function checkProperties(
  fields: readonly PropertyField[],
  values: Readonly<Record<string, unknown>>,
): PropertyProblem[] {
  const problems: PropertyProblem[] = [];
  const known = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(values))
    if (!known.has(key)) problems.push({ key, problem: 'UNKNOWN' });
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required) problems.push({ key: field.key, problem: 'REQUIRED' });
      continue;
    }
    switch (field.type) {
      case 'TEXT':
        if (typeof value !== 'string') problems.push({ key: field.key, problem: 'TYPE' });
        else if (value.length > field.maxLength)
          problems.push({ key: field.key, problem: 'TOO_LONG' });
        break;
      case 'NUMBER':
        if (typeof value !== 'number' || !Number.isFinite(value))
          problems.push({ key: field.key, problem: 'TYPE' });
        else if (
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max)
        )
          problems.push({ key: field.key, problem: 'RANGE' });
        break;
      case 'BOOLEAN':
        if (typeof value !== 'boolean') problems.push({ key: field.key, problem: 'TYPE' });
        break;
      case 'CHOICE':
        if (typeof value !== 'string') problems.push({ key: field.key, problem: 'TYPE' });
        else if (!field.options.includes(value))
          problems.push({ key: field.key, problem: 'NOT_AN_OPTION' });
        break;
    }
  }
  return problems;
}

/** A type's new fields must keep existing assets valid: no new required field, no removed or retyped field. */
export function compatibleChange(
  before: readonly PropertyField[],
  after: readonly PropertyField[],
): boolean {
  const next = new Map(after.map((f) => [f.key, f]));
  for (const old of before) {
    const now = next.get(old.key);
    if (!now || now.type !== old.type) return false;
    if (
      now.type === 'CHOICE' &&
      old.type === 'CHOICE' &&
      old.options.some((o) => !now.options.includes(o))
    )
      return false;
  }
  const existing = new Set(before.map((f) => f.key));
  return after.every((f) => existing.has(f.key) || !f.required);
}
