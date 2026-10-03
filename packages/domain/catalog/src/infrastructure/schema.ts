import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  classify,
  localeColumn,
  translationColumns,
  translationUnique,
  versioned,
} from '@hotella/platform-database';

/**
 * Guest service catalog (Spec §7, BUILD_PLAN §9, schema `catalog`). Foreign keys to `org.*`, `guest.*` and `ops.*` are
 * added by hand in the migrations. Published versions are immutable (database trigger, CLAUDE.md rule 9); request
 * history is append-only (rule 10).
 */
export const catalog = pgSchema('catalog');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const categoryStatus = catalog.enum('category_status', ['ACTIVE', 'INACTIVE']);
export const definitionStatus = catalog.enum('definition_status', ['ACTIVE', 'RETIRED']);
export const versionStatus = catalog.enum('version_status', ['DRAFT', 'PUBLISHED', 'SUPERSEDED']);
export const requestStatus = catalog.enum('request_status', [
  'OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);
export const requestSource = catalog.enum('request_source', [
  'GUEST_WEB',
  'WHATSAPP',
  'STAFF',
  'AI',
  'QR',
]);
export const requestEventType = catalog.enum('request_event_type', [
  'CREATED',
  'RELATED',
  'STATUS_CHANGED',
]);
export const priority = catalog.enum('priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']);

/** A grouping of services for guests (Housekeeping, Maintenance, Transport…). Null property: every property. */
export const serviceCategories = classify(
  catalog.table(
    'service_categories',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      code: varchar('code', { length: 64 }).notNull(),
      parentId: uuid('parent_id'),
      sortOrder: integer('sort_order').notNull().default(0),
      icon: varchar('icon', { length: 40 }),
      status: categoryStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('service_categories_tenant_code_uq')
        .on(t.tenantId, t.code)
        .where(sql`${t.propertyId} is null`),
      uniqueIndex('service_categories_property_code_uq')
        .on(t.tenantId, t.propertyId, t.code)
        .where(sql`${t.propertyId} is not null`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    code: 'INTERNAL',
    parentId: 'INTERNAL',
    sortOrder: 'INTERNAL',
    icon: 'PUBLIC',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);
export const serviceCategoryTranslations = classify(
  catalog.table(
    'service_category_translations',
    {
      ...translationColumns(() => serviceCategories.id),
      name: text('name').notNull(),
      description: text('description'),
    },
    (t) => [translationUnique('service_category_translations', t)],
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

/** A service (EXTRA_TOWELS…). Its behaviour lives in versions; `published_version_id` is the one guests get. */
export const serviceDefinitions = classify(
  catalog.table(
    'service_definitions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      code: varchar('code', { length: 64 }).notNull(),
      categoryId: uuid('category_id')
        .notNull()
        .references(() => serviceCategories.id, { onDelete: 'restrict' }),
      status: definitionStatus('status').notNull().default('ACTIVE'),
      publishedVersionId: uuid('published_version_id'),
      sortOrder: integer('sort_order').notNull().default(0),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('service_definitions_tenant_code_uq')
        .on(t.tenantId, t.code)
        .where(sql`${t.propertyId} is null`),
      uniqueIndex('service_definitions_property_code_uq')
        .on(t.tenantId, t.propertyId, t.code)
        .where(sql`${t.propertyId} is not null`),
      index('service_definitions_category_idx').on(t.categoryId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    code: 'INTERNAL',
    categoryId: 'INTERNAL',
    status: 'INTERNAL',
    publishedVersionId: 'INTERNAL',
    sortOrder: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** One version of a service's behaviour; immutable once published (trigger), except PUBLISHED → SUPERSEDED. */
export const serviceVersions = classify(
  catalog.table(
    'service_versions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      definitionId: uuid('definition_id')
        .notNull()
        .references(() => serviceDefinitions.id, { onDelete: 'cascade' }),
      versionNo: integer('version_no').notNull(),
      status: versionStatus('status').notNull().default('DRAFT'),
      departmentCode: varchar('department_code', { length: 32 }).notNull(),
      priority: priority('priority').notNull().default('NORMAL'),
      workflowCode: varchar('workflow_code', { length: 64 }),
      requiredFields: jsonb('required_fields').notNull().default([]),
      eligibility: jsonb('eligibility').notNull().default({}),
      availability: jsonb('availability').notNull().default({}),
      guestVisible: boolean('guest_visible').notNull().default(true),
      automationPolicy: jsonb('automation_policy').notNull().default({}),
      price: jsonb('price'),
      duplicateWindowMinutes: smallint('duplicate_window_minutes').notNull().default(30),
      publishedAt: tz('published_at'),
      publishedBy: uuid('published_by'),
      ...versioned(),
    },
    (t) => [
      unique('service_versions_definition_no_uq').on(t.definitionId, t.versionNo),
      uniqueIndex('service_versions_one_draft_uq')
        .on(t.definitionId)
        .where(sql`${t.status} = 'DRAFT'`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    definitionId: 'INTERNAL',
    versionNo: 'INTERNAL',
    status: 'INTERNAL',
    departmentCode: 'INTERNAL',
    priority: 'INTERNAL',
    workflowCode: 'INTERNAL',
    requiredFields: 'INTERNAL',
    eligibility: 'INTERNAL',
    availability: 'INTERNAL',
    guestVisible: 'INTERNAL',
    automationPolicy: 'INTERNAL',
    price: 'PUBLIC',
    duplicateWindowMinutes: 'INTERNAL',
    publishedAt: 'INTERNAL',
    publishedBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);
export const serviceVersionTranslations = classify(
  catalog.table(
    'service_version_translations',
    {
      ...translationColumns(() => serviceVersions.id),
      name: text('name').notNull(),
      shortDescription: text('short_description'),
      description: text('description'),
      /** Phrases guests use for this service (AI intent hints from Phase 6). */
      guestPromptHints: text('guest_prompt_hints'),
      /** `{ field: { label, options: { CODE: label } } }` */
      fieldLabels: jsonb('field_labels').notNull().default({}),
    },
    (t) => [translationUnique('service_version_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'PUBLIC',
    shortDescription: 'PUBLIC',
    description: 'PUBLIC',
    guestPromptHints: 'INTERNAL',
    fieldLabels: 'PUBLIC',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** A guest's (or staff's, on their behalf) request for a service; the work lives in the operations context. */
export const serviceRequests = classify(
  catalog.table(
    'service_requests',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      definitionId: uuid('definition_id')
        .notNull()
        .references(() => serviceDefinitions.id, { onDelete: 'restrict' }),
      serviceVersionId: uuid('service_version_id')
        .notNull()
        .references(() => serviceVersions.id, { onDelete: 'restrict' }),
      serviceCode: varchar('service_code', { length: 64 }).notNull(),
      guestId: uuid('guest_id').notNull(),
      stayId: uuid('stay_id').notNull(),
      roomId: uuid('room_id'),
      conversationId: uuid('conversation_id'),
      workItemId: uuid('work_item_id'),
      status: requestStatus('status').notNull().default('OPEN'),
      /** Submitted field values; TEXT values are the guest's words (cleared on anonymization). */
      fields: jsonb('fields').notNull().default({}),
      requestedForAt: tz('requested_for_at'),
      locale: localeColumn(),
      source: requestSource('source').notNull(),
      createdByType: varchar('created_by_type', { length: 16 }).notNull(),
      createdById: uuid('created_by_id'),
      relatedCount: integer('related_count').notNull().default(0),
      lastRelatedAt: tz('last_related_at'),
      closedAt: tz('closed_at'),
      ...versioned(),
    },
    (t) => [
      index('service_requests_stay_service_idx').on(t.tenantId, t.stayId, t.definitionId, t.status),
      index('service_requests_board_idx').on(t.tenantId, t.propertyId, t.status, t.createdAt),
      index('service_requests_guest_idx').on(t.tenantId, t.guestId),
      uniqueIndex('service_requests_work_item_uq').on(t.workItemId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    definitionId: 'INTERNAL',
    serviceVersionId: 'INTERNAL',
    serviceCode: 'INTERNAL',
    guestId: 'INTERNAL',
    stayId: 'INTERNAL',
    roomId: 'INTERNAL',
    conversationId: 'INTERNAL',
    workItemId: 'INTERNAL',
    status: 'INTERNAL',
    fields: 'CONFIDENTIAL',
    requestedForAt: 'INTERNAL',
    locale: 'INTERNAL',
    source: 'INTERNAL',
    createdByType: 'INTERNAL',
    createdById: 'INTERNAL',
    relatedCount: 'INTERNAL',
    lastRelatedAt: 'INTERNAL',
    closedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** History of a request (append-only by trigger; only free text may be cleared for anonymization). */
export const serviceRequestEvents = classify(
  catalog.table(
    'service_request_events',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      requestId: uuid('request_id')
        .notNull()
        .references(() => serviceRequests.id, { onDelete: 'restrict' }),
      type: requestEventType('type').notNull(),
      fromStatus: requestStatus('from_status'),
      toStatus: requestStatus('to_status'),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      source: requestSource('source'),
      /** Field values of a related (duplicate) ask. */
      fields: jsonb('fields'),
      reason: text('reason'),
      occurredAt: tz('occurred_at').notNull().defaultNow(),
    },
    (t) => [index('service_request_events_request_idx').on(t.tenantId, t.requestId, t.id)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    requestId: 'INTERNAL',
    type: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    source: 'INTERNAL',
    fields: 'CONFIDENTIAL',
    reason: 'CONFIDENTIAL',
    occurredAt: 'INTERNAL',
  },
);

export type CategoryRow = typeof serviceCategories.$inferSelect;
export type CategoryTranslationRow = typeof serviceCategoryTranslations.$inferSelect;
export type DefinitionRow = typeof serviceDefinitions.$inferSelect;
export type VersionRow = typeof serviceVersions.$inferSelect;
export type VersionTranslationRow = typeof serviceVersionTranslations.$inferSelect;
export type RequestRow = typeof serviceRequests.$inferSelect;
export type RequestEventRow = typeof serviceRequestEvents.$inferSelect;
