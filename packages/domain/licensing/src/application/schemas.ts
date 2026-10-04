import { z } from 'zod';

/** Request bodies of the control-plane licensing API (platform administrators). */

const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
export const PLAN_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const capabilityCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

const translations = z
  .array(
    z.object({
      locale: localeSchema,
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(2000).nullish(),
    }),
  )
  .min(1)
  .max(20)
  .refine((t) => new Set(t.map((x) => x.locale)).size === t.length, 'one translation per locale');

export const limitSchema = z.object({
  metricCode: capabilityCode,
  scope: z.enum(['TENANT', 'PROPERTY']),
  period: z.enum(['NONE', 'DAY', 'MONTH']),
  limitValue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  enforcement: z.enum(['SOFT', 'HARD']),
});

export const createPlanSchema = z.object({
  code: z.string().regex(PLAN_CODE_RE),
  translations,
});
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = z.object({
  version: z.number().int().min(1),
  translations: translations.optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

export const createDraftSchema = z.object({
  /** Copy the content of this version (default: the latest published one, else empty). */
  fromVersionId: z.uuid().optional(),
});
export type CreateDraftInput = z.infer<typeof createDraftSchema>;

export const updateDraftSchema = z.object({
  version: z.number().int().min(1),
  notes: z.string().trim().max(2000).nullish(),
  items: z.array(capabilityCode).max(200).optional(),
  limits: z.array(limitSchema).max(100).optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const versionActionSchema = z.object({ version: z.number().int().min(1) });
export type VersionActionInput = z.infer<typeof versionActionSchema>;
