import { z } from 'zod';
import {
  automationPolicySchema,
  availabilitySchema,
  eligibilitySchema,
  FIELD_CODE_RE,
  priceSchema,
  requiredFieldsSchema,
  SERVICE_CODE_RE,
} from '../domain/rules';

/** Request bodies of the catalog administration API (staff, `catalog.manage` / `catalog.publish`). */

export const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/);
const name = z.string().trim().min(1).max(120);
const longText = z.string().trim().max(2000);
const departmentCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/);

export const translationSchema = z.object({
  locale: localeSchema,
  name,
  description: longText.nullish(),
});
const translations = z
  .array(translationSchema)
  .min(1)
  .max(20)
  .refine((t) => new Set(t.map((x) => x.locale)).size === t.length, 'one translation per locale');

export const fieldLabelsSchema = z.record(
  z.string().regex(FIELD_CODE_RE),
  z.object({
    label: z.string().trim().min(1).max(80),
    options: z.record(z.string(), z.string().trim().min(1).max(80)).optional(),
  }),
);
export const versionTranslationSchema = translationSchema.extend({
  shortDescription: z.string().trim().max(200).nullish(),
  guestPromptHints: longText.nullish(),
  fieldLabels: fieldLabelsSchema.default({}),
});
const versionTranslations = z
  .array(versionTranslationSchema)
  .min(1)
  .max(20)
  .refine((t) => new Set(t.map((x) => x.locale)).size === t.length, 'one translation per locale');

export const createCategorySchema = z.object({
  /** Omitted: the category serves every property of the tenant. */
  propertyId: z.uuid().nullish(),
  code: z.string().regex(SERVICE_CODE_RE),
  parentId: z.uuid().nullish(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  icon: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .nullish(),
  translations,
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  version: z.number().int().min(1),
  parentId: z.uuid().nullish(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  icon: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  translations: translations.optional(),
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

/** The behaviour of a version (everything publishing freezes), without defaults: a partial update keeps the rest. */
const draftFields = {
  departmentCode,
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  workflowCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .nullish(),
  requiredFields: requiredFieldsSchema,
  eligibility: eligibilitySchema,
  availability: availabilitySchema,
  guestVisible: z.boolean(),
  automationPolicy: automationPolicySchema,
  price: priceSchema,
  duplicateWindowMinutes: z.number().int().min(0).max(1440).nullish(),
  translations: versionTranslations,
};

/** A new draft: everything but the department and the translations has a default. */
export const draftSchema = z.object({
  ...draftFields,
  priority: draftFields.priority.default('NORMAL'),
  requiredFields: requiredFieldsSchema.default([]),
  eligibility: eligibilitySchema.default({
    stayStatuses: ['IN_HOUSE'],
    partyRoles: ['PRIMARY', 'ACCOMPANYING'],
    roomTypeIds: [],
  }),
  availability: availabilitySchema.default({
    hours: [],
    leadTimeMinutes: 0,
    allowScheduling: false,
    maxPerStayPerDay: null,
  }),
  guestVisible: z.boolean().default(true),
  automationPolicy: automationPolicySchema.default({
    aiMayCreate: true,
    aiRequiresConfirmation: false,
  }),
  price: priceSchema.default(null),
});
export type DraftInput = z.infer<typeof draftSchema>;

export const createServiceSchema = z.object({
  propertyId: z.uuid().nullish(),
  code: z.string().regex(SERVICE_CODE_RE),
  categoryId: z.uuid(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  draft: draftSchema,
});
export type CreateServiceInput = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  version: z.number().int().min(1),
  categoryId: z.uuid().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(['ACTIVE', 'RETIRED']).optional(),
});
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;

/** Only the given keys change (no defaults here, see `draftFields`). */
export const updateDraftSchema = z
  .object(draftFields)
  .partial()
  .extend({ version: z.number().int().min(1) });
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const publishSchema = z.object({ version: z.number().int().min(1) });

export const catalogQuerySchema = z.object({ propertyId: z.uuid().optional() });
