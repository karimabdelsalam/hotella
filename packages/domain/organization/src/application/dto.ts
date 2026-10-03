import { z } from 'zod';
import { localeSchema, uuidSchema } from '@hotella/contracts-api';
import { APPROVED_FONTS, CODE_RE, HEX_COLOR_RE } from '../domain/values';

const code = z.string().trim().toUpperCase().regex(CODE_RE, 'Code: 2–32 chars, A–Z 0–9 _ -');
const translation = z.object({
  locale: localeSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
});

export const createTenantSchema = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  defaultLocale: localeSchema.default('en'),
  defaultTimezone: z.string().min(1).max(64).default('Africa/Cairo'),
  defaultCurrency: z.string().length(3).toUpperCase().default('EGP'),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const createOrganizationSchema = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(300).nullish(),
  type: z.enum(['GROUP', 'BRAND', 'LEGAL_ENTITY', 'OTHER']).default('BRAND'),
  parentId: uuidSchema.nullish(),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const createPropertySchema = z.object({
  /** Platform admins must name the tenant; tenant users may omit it (their own tenant is implied). */
  tenantId: uuidSchema.optional(),
  organizationId: uuidSchema.nullish(),
  code,
  name: z.string().trim().min(1).max(200),
  timezone: z.string().min(1).max(64),
  currency: z.string().length(3).toUpperCase(),
  defaultLocale: localeSchema.default('en'),
  enabledLocales: z.array(localeSchema).min(1).default(['en', 'ar']),
  country: z.string().length(2).toUpperCase().nullish(),
  address: z.record(z.string(), z.unknown()).default({}),
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullish(),
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

export const updatePropertySchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  timezone: z.string().min(1).max(64).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  defaultLocale: localeSchema.optional(),
  enabledLocales: z.array(localeSchema).min(1).optional(),
  country: z.string().length(2).toUpperCase().nullish(),
  address: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;

export const createLocationSchema = z.object({
  parentId: uuidSchema.nullish(),
  kind: z.enum(['BUILDING', 'FLOOR', 'AREA', 'PLANT', 'OTHER']),
  code: z.string().trim().min(1).max(64),
  sortOrder: z.number().int().default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
  translations: z.array(translation).min(1),
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const createRoomTypeSchema = z.object({
  code,
  capacity: z.number().int().min(1).max(20).default(2),
  attributes: z.record(z.string(), z.unknown()).default({}),
  translations: z.array(translation).min(1),
});
export type CreateRoomTypeInput = z.infer<typeof createRoomTypeSchema>;

export const createRoomSchema = z.object({
  parentId: uuidSchema,
  roomNumber: z.string().trim().min(1).max(16),
  roomTypeId: uuidSchema.nullish(),
  bedConfig: z.string().trim().max(64).nullish(),
  floorLabel: z.string().trim().max(32).nullish(),
  connectingRoomId: uuidSchema.nullish(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  /** Optional display names; default is the room number in every locale. */
  translations: z.array(translation).default([]),
});
export type CreateRoomInput = z.infer<typeof createRoomSchema>;

const fontName = z.enum(APPROVED_FONTS);
export const upsertBrandProfileSchema = z.object({
  scope: z.enum(['TENANT', 'ORGANIZATION', 'PROPERTY', 'CHANNEL']),
  /** Tenant id for TENANT, organization id, or property id (CHANNEL = property id + channel). */
  scopeId: uuidSchema,
  channel: z.enum(['GUEST_WEB', 'ROOM_QR', 'WHATSAPP', 'APP', 'VOICE', 'EMAIL']).nullish(),
  displayName: z.string().trim().min(1).max(200).nullish(),
  logoAssetKey: z.string().max(512).nullish(),
  logoAltAssetKey: z.string().max(512).nullish(),
  primaryColor: z.string().regex(HEX_COLOR_RE).nullish(),
  secondaryColor: z.string().regex(HEX_COLOR_RE).nullish(),
  coverAssetKeys: z.array(z.string().max(512)).max(10).default([]),
  faviconAssetKey: z.string().max(512).nullish(),
  typography: z
    .object({
      heading: fontName.optional(),
      body: fontName.optional(),
      arabic: fontName.optional(),
    })
    .default({}),
  contact: z
    .object({
      phone: z.string().max(32).optional(),
      whatsapp: z.string().max(32).optional(),
      email: z.email().optional(),
      website: z.url().optional(),
    })
    .default({}),
  social: z.record(z.string().max(32), z.url()).default({}),
  /** Within platform policy: tone only; no instructions that could weaken safety (validated server-side). */
  aiPersona: z
    .object({
      tone: z.enum(['warm-professional', 'formal', 'friendly', 'concise']).optional(),
      signoff: z.string().max(80).optional(),
    })
    .default({}),
  presentation: z.record(z.string(), z.unknown()).default({}),
  translations: z
    .array(
      z.object({
        locale: localeSchema,
        welcomeText: z.string().max(500).nullish(),
        farewellText: z.string().max(500).nullish(),
      }),
    )
    .default([]),
});
export type UpsertBrandProfileInput = z.infer<typeof upsertBrandProfileSchema>;

export const publicBrandingQuerySchema = z.object({
  property: uuidSchema,
  channel: z.enum(['GUEST_WEB', 'ROOM_QR', 'WHATSAPP', 'APP', 'VOICE', 'EMAIL']).optional(),
  lang: localeSchema.optional(),
});
