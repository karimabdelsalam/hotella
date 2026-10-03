import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  char,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  classify,
  ltree,
  propertyScoped,
  tenantScoped,
  translationColumns,
  translationUnique,
  versioned,
} from '@hotella/platform-database';

export const org = pgSchema('org');

export const tenantStatus = org.enum('tenant_status', ['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
export const organizationType = org.enum('organization_type', [
  'GROUP',
  'BRAND',
  'LEGAL_ENTITY',
  'OTHER',
]);
export const activeStatus = org.enum('active_status', ['ACTIVE', 'INACTIVE']);
export const propertyStatus = org.enum('property_status', ['DRAFT', 'ACTIVE', 'INACTIVE']);
export const locationKind = org.enum('location_kind', [
  'PROPERTY',
  'BUILDING',
  'FLOOR',
  'ROOM',
  'AREA',
  'PLANT',
  'OTHER',
]);
export const brandScope = org.enum('brand_scope', [
  'TENANT',
  'ORGANIZATION',
  'PROPERTY',
  'CHANNEL',
]);

/** Spec §4.1 — the top-level SaaS customer. Has no tenant_id: it *is* the tenant. */
export const tenants = classify(
  org.table('tenants', {
    ...baseColumns(),
    code: varchar('code', { length: 32 }).notNull().unique(),
    name: text('name').notNull(),
    status: tenantStatus('status').notNull().default('ACTIVE'),
    defaultLocale: varchar('default_locale', { length: 16 }).notNull().default('en'),
    defaultTimezone: varchar('default_timezone', { length: 64 }).notNull().default('Africa/Cairo'),
    defaultCurrency: char('default_currency', { length: 3 }).notNull().default('EGP'),
    settings: jsonb('settings').notNull().default({}),
    ...versioned(),
  }),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    code: 'INTERNAL',
    name: 'INTERNAL',
    status: 'INTERNAL',
    defaultLocale: 'INTERNAL',
    defaultTimezone: 'INTERNAL',
    defaultCurrency: 'INTERNAL',
    settings: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Referential integrity for tenant scoping (CLAUDE.md rule 1): every tenant-owned row points at a real tenant. */
function tenantFk(table: string, column: AnyPgColumn) {
  return foreignKey({
    name: `${table}_tenant_fk`,
    columns: [column],
    foreignColumns: [tenants.id],
  }).onDelete('restrict');
}

/** Property-scoped rows point at a real property; deleting a property removes its structure. */
function propertyFk(table: string, column: AnyPgColumn) {
  return foreignKey({
    name: `${table}_property_fk`,
    columns: [column],
    foreignColumns: [properties.id],
  }).onDelete('cascade');
}

/** Spec §4.2 — brands / legal entities inside a tenant. */
export const organizations = classify(
  org.table(
    'organizations',
    {
      ...baseColumns(),
      ...tenantScoped(),
      parentId: uuid('parent_id'),
      code: varchar('code', { length: 32 }).notNull(),
      name: text('name').notNull(),
      legalName: text('legal_name'),
      type: organizationType('type').notNull().default('BRAND'),
      status: activeStatus('status').notNull().default('ACTIVE'),
      settings: jsonb('settings').notNull().default({}),
      ...versioned(),
    },
    (t) => [
      unique('organizations_tenant_code_uq').on(t.tenantId, t.code),
      index('organizations_tenant_idx').on(t.tenantId),
      tenantFk('organizations', t.tenantId),
      foreignKey({
        name: 'organizations_parent_fk',
        columns: [t.parentId],
        foreignColumns: [t.id],
      }).onDelete('set null'),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    parentId: 'INTERNAL',
    code: 'INTERNAL',
    name: 'INTERNAL',
    legalName: 'CONFIDENTIAL',
    type: 'INTERNAL',
    status: 'INTERNAL',
    settings: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Spec §4.3 — a hotel. */
export const properties = classify(
  org.table(
    'properties',
    {
      ...baseColumns(),
      ...tenantScoped(),
      organizationId: uuid('organization_id').references(() => organizations.id, {
        onDelete: 'set null',
      }),
      code: varchar('code', { length: 32 }).notNull(),
      name: text('name').notNull(),
      timezone: varchar('timezone', { length: 64 }).notNull(),
      currency: char('currency', { length: 3 }).notNull(),
      defaultLocale: varchar('default_locale', { length: 16 }).notNull().default('en'),
      enabledLocales: text('enabled_locales')
        .array()
        .notNull()
        .default(sql`'{en,ar}'::text[]`),
      country: char('country', { length: 2 }),
      address: jsonb('address').notNull().default({}),
      geoLat: numeric('geo_lat', { precision: 9, scale: 6 }),
      geoLng: numeric('geo_lng', { precision: 9, scale: 6 }),
      status: propertyStatus('status').notNull().default('DRAFT'),
      settings: jsonb('settings').notNull().default({}),
      ...versioned(),
    },
    (t) => [
      unique('properties_tenant_code_uq').on(t.tenantId, t.code),
      index('properties_tenant_idx').on(t.tenantId),
      tenantFk('properties', t.tenantId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    organizationId: 'INTERNAL',
    code: 'INTERNAL',
    name: 'PUBLIC',
    timezone: 'PUBLIC',
    currency: 'PUBLIC',
    defaultLocale: 'PUBLIC',
    enabledLocales: 'PUBLIC',
    country: 'PUBLIC',
    address: 'PUBLIC',
    geoLat: 'PUBLIC',
    geoLng: 'PUBLIC',
    status: 'INTERNAL',
    settings: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Spec §4.4 — generic location tree; a room is a specialization (see `rooms`). */
export const locations = classify(
  org.table(
    'locations',
    {
      ...baseColumns(),
      ...propertyScoped(),
      parentId: uuid('parent_id'),
      kind: locationKind('kind').notNull(),
      code: varchar('code', { length: 64 }).notNull(),
      path: ltree('path').notNull(),
      sortOrder: integer('sort_order').notNull().default(0),
      status: activeStatus('status').notNull().default('ACTIVE'),
      metadata: jsonb('metadata').notNull().default({}),
      ...versioned(),
    },
    (t) => [
      unique('locations_property_path_uq').on(t.propertyId, t.path),
      index('locations_path_gist').using('gist', t.path),
      index('locations_parent_idx').on(t.propertyId, t.parentId),
      tenantFk('locations', t.tenantId),
      propertyFk('locations', t.propertyId),
      foreignKey({
        name: 'locations_parent_fk',
        columns: [t.parentId],
        foreignColumns: [t.id],
      }).onDelete('cascade'),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    parentId: 'INTERNAL',
    kind: 'INTERNAL',
    code: 'INTERNAL',
    path: 'INTERNAL',
    sortOrder: 'INTERNAL',
    status: 'INTERNAL',
    metadata: 'INTERNAL',
    version: 'INTERNAL',
  },
);
export const locationTranslations = classify(
  org.table(
    'location_translations',
    {
      ...translationColumns(() => locations.id),
      name: text('name').notNull(),
      description: text('description'),
    },
    (t) => [translationUnique('location_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'PUBLIC',
    description: 'PUBLIC',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

export const roomTypes = classify(
  org.table(
    'room_types',
    {
      ...baseColumns(),
      ...propertyScoped(),
      code: varchar('code', { length: 32 }).notNull(),
      capacity: integer('capacity').notNull().default(2),
      attributes: jsonb('attributes').notNull().default({}),
      ...versioned(),
    },
    (t) => [
      unique('room_types_property_code_uq').on(t.propertyId, t.code),
      tenantFk('room_types', t.tenantId),
      propertyFk('room_types', t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    code: 'INTERNAL',
    capacity: 'PUBLIC',
    attributes: 'INTERNAL',
    version: 'INTERNAL',
  },
);
export const roomTypeTranslations = classify(
  org.table(
    'room_type_translations',
    {
      ...translationColumns(() => roomTypes.id),
      name: text('name').notNull(),
      description: text('description'),
    },
    (t) => [translationUnique('room_type_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'PUBLIC',
    description: 'PUBLIC',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** Spec §4.4 — "a room is a specialization of a location": PK = the location id. */
export const rooms = classify(
  org.table(
    'rooms',
    {
      locationId: uuid('location_id')
        .primaryKey()
        .references(() => locations.id, { onDelete: 'cascade' }),
      ...propertyScoped(),
      roomNumber: varchar('room_number', { length: 16 }).notNull(),
      roomTypeId: uuid('room_type_id').references(() => roomTypes.id, { onDelete: 'set null' }),
      bedConfig: varchar('bed_config', { length: 64 }),
      floorLabel: varchar('floor_label', { length: 32 }),
      connectingRoomId: uuid('connecting_room_id'),
      attributes: jsonb('attributes').notNull().default({}),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow()
        .$onUpdateFn(() => new Date()),
    },
    (t) => [
      unique('rooms_property_number_uq').on(t.propertyId, t.roomNumber),
      index('rooms_property_idx').on(t.propertyId),
      tenantFk('rooms', t.tenantId),
      propertyFk('rooms', t.propertyId),
      foreignKey({
        name: 'rooms_connecting_room_fk',
        columns: [t.connectingRoomId],
        foreignColumns: [t.locationId],
      }).onDelete('set null'),
    ],
  ),
  {
    locationId: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    roomNumber: 'INTERNAL',
    roomTypeId: 'INTERNAL',
    bedConfig: 'INTERNAL',
    floorLabel: 'INTERNAL',
    connectingRoomId: 'INTERNAL',
    attributes: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** Product Identity — brand profile per scope; resolution tenant → organization → property → channel. */
export const brandProfiles = classify(
  org.table(
    'brand_profiles',
    {
      ...baseColumns(),
      ...tenantScoped(),
      scope: brandScope('scope').notNull(),
      scopeId: uuid('scope_id').notNull(),
      channel: varchar('channel', { length: 32 }),
      displayName: text('display_name'),
      logoAssetKey: text('logo_asset_key'),
      logoAltAssetKey: text('logo_alt_asset_key'),
      primaryColor: varchar('primary_color', { length: 9 }),
      secondaryColor: varchar('secondary_color', { length: 9 }),
      coverAssetKeys: text('cover_asset_keys')
        .array()
        .notNull()
        .default(sql`'{}'::text[]`),
      faviconAssetKey: text('favicon_asset_key'),
      typography: jsonb('typography').notNull().default({}),
      contact: jsonb('contact').notNull().default({}),
      social: jsonb('social').notNull().default({}),
      aiPersona: jsonb('ai_persona').notNull().default({}),
      presentation: jsonb('presentation').notNull().default({}),
      ...versioned(),
    },
    (t) => [
      unique('brand_profiles_scope_uq')
        .on(t.tenantId, t.scope, t.scopeId, t.channel)
        .nullsNotDistinct(),
      tenantFk('brand_profiles', t.tenantId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    scope: 'INTERNAL',
    scopeId: 'INTERNAL',
    channel: 'INTERNAL',
    displayName: 'PUBLIC',
    logoAssetKey: 'PUBLIC',
    logoAltAssetKey: 'PUBLIC',
    primaryColor: 'PUBLIC',
    secondaryColor: 'PUBLIC',
    coverAssetKeys: 'PUBLIC',
    faviconAssetKey: 'PUBLIC',
    typography: 'PUBLIC',
    contact: 'PUBLIC',
    social: 'PUBLIC',
    aiPersona: 'INTERNAL',
    presentation: 'PUBLIC',
    version: 'INTERNAL',
  },
);
export const brandProfileTranslations = classify(
  org.table(
    'brand_profile_translations',
    {
      ...translationColumns(() => brandProfiles.id),
      welcomeText: text('welcome_text'),
      farewellText: text('farewell_text'),
    },
    (t) => [translationUnique('brand_profile_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    welcomeText: 'PUBLIC',
    farewellText: 'PUBLIC',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

export type TenantRow = typeof tenants.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type PropertyRow = typeof properties.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type RoomTypeRow = typeof roomTypes.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type BrandProfileRow = typeof brandProfiles.$inferSelect;
