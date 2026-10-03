import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  classify,
  translationColumns,
  translationUnique,
  versioned,
} from '@hotella/platform-database';
import type { PropertyField } from '../domain/properties';

/**
 * Engineering / CMMS (Spec §10, BUILD_PLAN Phase 8, schema `eng`). Assets are tenant-owned and placed at an organization
 * location (room, plant room, floor); documents live in the knowledge layer and are only linked here.
 */
export const eng = pgSchema('eng');

export const assetStatus = eng.enum('asset_status', ['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED']);
export const criticality = eng.enum('criticality', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const documentKind = eng.enum('asset_document_kind', [
  'MANUAL',
  'DATASHEET',
  'WARRANTY',
  'DIAGRAM',
  'PHOTO',
]);
export const failureKind = eng.enum('failure_kind', [
  'SYMPTOM',
  'FAILURE_MODE',
  'CAUSE',
  'RESOLUTION',
]);

/** A kind of equipment (fan-coil unit, chiller, pump) with its controlled properties (Spec §10.2). */
export const assetTypes = classify(
  eng.table(
    'asset_types',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      code: varchar('code', { length: 40 }).notNull(),
      properties: jsonb('properties').$type<PropertyField[]>().notNull().default([]),
      active: boolean('active').notNull().default(true),
      ...versioned(),
    },
    (t) => [uniqueIndex('asset_types_code_uq').on(t.tenantId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    code: 'INTERNAL',
    properties: 'INTERNAL',
    active: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const assetTypeTranslations = classify(
  eng.table(
    'asset_type_translations',
    { ...translationColumns(() => assetTypes.id), name: text('name').notNull() },
    (t) => [translationUnique('asset_type_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** A manufacturer's model: identical equipment shares failure history and manuals (Spec §10.2). */
export const assetModels = classify(
  eng.table(
    'asset_models',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      assetTypeId: uuid('asset_type_id')
        .notNull()
        .references(() => assetTypes.id, { onDelete: 'restrict' }),
      manufacturer: varchar('manufacturer', { length: 120 }).notNull(),
      modelCode: varchar('model_code', { length: 120 }).notNull(),
      expectedLifeMonths: integer('expected_life_months'),
      ...versioned(),
    },
    (t) => [uniqueIndex('asset_models_uq').on(t.tenantId, t.manufacturer, t.modelCode)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    assetTypeId: 'INTERNAL',
    manufacturer: 'INTERNAL',
    modelCode: 'INTERNAL',
    expectedLifeMonths: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A piece of equipment at a place, possibly part of a larger asset (AHU-01 → motor, fan, belt). */
export const assets = classify(
  eng.table(
    'assets',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      parentAssetId: uuid('parent_asset_id'),
      assetNumber: varchar('asset_number', { length: 40 }).notNull(),
      assetTypeId: uuid('asset_type_id')
        .notNull()
        .references(() => assetTypes.id, { onDelete: 'restrict' }),
      assetModelId: uuid('asset_model_id').references(() => assetModels.id, {
        onDelete: 'restrict',
      }),
      locationId: uuid('location_id').notNull(),
      name: varchar('name', { length: 200 }).notNull(),
      serialNumber: varchar('serial_number', { length: 120 }),
      status: assetStatus('status').notNull().default('ACTIVE'),
      criticality: criticality('criticality').notNull().default('MEDIUM'),
      installedAt: date('installed_at', { mode: 'string' }),
      warrantyUntil: date('warranty_until', { mode: 'string' }),
      properties: jsonb('properties')
        .$type<Record<string, string | number | boolean>>()
        .notNull()
        .default({}),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('assets_number_uq').on(t.propertyId, t.assetNumber),
      index('assets_location_idx').on(t.tenantId, t.locationId),
      index('assets_parent_idx').on(t.parentAssetId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    parentAssetId: 'INTERNAL',
    assetNumber: 'INTERNAL',
    assetTypeId: 'INTERNAL',
    assetModelId: 'INTERNAL',
    locationId: 'INTERNAL',
    name: 'INTERNAL',
    serialNumber: 'INTERNAL',
    status: 'INTERNAL',
    criticality: 'INTERNAL',
    installedAt: 'INTERNAL',
    warrantyUntil: 'INTERNAL',
    properties: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A knowledge document linked to an asset or to its model (Spec §10.3); the file and its versions are Knowledge's. */
export const assetDocuments = classify(
  eng.table(
    'asset_documents',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }),
      assetModelId: uuid('asset_model_id').references(() => assetModels.id, {
        onDelete: 'cascade',
      }),
      knowledgeDocumentId: uuid('knowledge_document_id').notNull(),
      kind: documentKind('kind').notNull(),
    },
    (t) => [
      uniqueIndex('asset_documents_asset_uq')
        .on(t.assetId, t.knowledgeDocumentId)
        .where(sql`${t.assetId} is not null`),
      uniqueIndex('asset_documents_model_uq')
        .on(t.assetModelId, t.knowledgeDocumentId)
        .where(sql`${t.assetModelId} is not null`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    assetId: 'INTERNAL',
    assetModelId: 'INTERNAL',
    knowledgeDocumentId: 'INTERNAL',
    kind: 'INTERNAL',
  },
);

/** One code of the failure taxonomy (Spec §10.5), optionally for one asset type. */
export const failureCodes = classify(
  eng.table(
    'failure_codes',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      kind: failureKind('kind').notNull(),
      code: varchar('code', { length: 60 }).notNull(),
      assetTypeId: uuid('asset_type_id').references(() => assetTypes.id, { onDelete: 'restrict' }),
      active: boolean('active').notNull().default(true),
    },
    (t) => [uniqueIndex('failure_codes_uq').on(t.tenantId, t.kind, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    kind: 'INTERNAL',
    code: 'INTERNAL',
    assetTypeId: 'INTERNAL',
    active: 'INTERNAL',
  },
);

export const failureCodeTranslations = classify(
  eng.table(
    'failure_code_translations',
    { ...translationColumns(() => failureCodes.id), name: text('name').notNull() },
    (t) => [translationUnique('failure_code_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

export type AssetTypeRow = typeof assetTypes.$inferSelect;
export type AssetModelRow = typeof assetModels.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type AssetDocumentRow = typeof assetDocuments.$inferSelect;
export type FailureCodeRow = typeof failureCodes.$inferSelect;

// ---- work orders (Spec §10.4, BUILD_PLAN 8.2) ----

export const workOrderType = eng.enum('work_order_type', [
  'CORRECTIVE',
  'PREVENTIVE',
  'PREDICTIVE',
  'INSPECTION',
  'EMERGENCY',
  'PROJECT',
]);
export const workOrderSource = eng.enum('work_order_source', [
  'STAFF',
  'GUEST_REQUEST',
  'PM',
  'INSPECTION',
  'AI',
]);
export const workOrderStatus = eng.enum('work_order_status', [
  'OPEN',
  'IN_PROGRESS',
  'DONE',
  'CANCELLED',
]);

/** Engineering work on an asset or at a place; its assignment, SLA and history are its work item's. */
export const workOrders = classify(
  eng.table(
    'work_orders',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      number: integer('number').notNull(),
      workItemId: uuid('work_item_id').notNull(),
      type: workOrderType('type').notNull(),
      source: workOrderSource('source').notNull(),
      assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'restrict' }),
      locationId: uuid('location_id').notNull(),
      reportedAt: timestamp('reported_at', { withTimezone: true, mode: 'date' }).notNull(),
      symptomCode: varchar('symptom_code', { length: 60 }),
      /** What the engineer found, in their words (may mention the guest: CONFIDENTIAL). */
      diagnosis: text('diagnosis'),
      failureModeCode: varchar('failure_mode_code', { length: 60 }),
      causeCode: varchar('cause_code', { length: 60 }),
      resolutionCode: varchar('resolution_code', { length: 60 }),
      downtimeStartedAt: timestamp('downtime_started_at', { withTimezone: true, mode: 'date' }),
      downtimeEndedAt: timestamp('downtime_ended_at', { withTimezone: true, mode: 'date' }),
      status: workOrderStatus('status').notNull().default('OPEN'),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('work_orders_work_item_uq').on(t.workItemId),
      uniqueIndex('work_orders_number_uq').on(t.propertyId, t.number),
      index('work_orders_asset_idx').on(t.tenantId, t.assetId),
      index('work_orders_property_idx').on(t.tenantId, t.propertyId, t.status),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    number: 'INTERNAL',
    workItemId: 'INTERNAL',
    type: 'INTERNAL',
    source: 'INTERNAL',
    assetId: 'INTERNAL',
    locationId: 'INTERNAL',
    reportedAt: 'INTERNAL',
    symptomCode: 'INTERNAL',
    diagnosis: 'CONFIDENTIAL',
    failureModeCode: 'INTERNAL',
    causeCode: 'INTERNAL',
    resolutionCode: 'INTERNAL',
    downtimeStartedAt: 'INTERNAL',
    downtimeEndedAt: 'INTERNAL',
    status: 'INTERNAL',
    completedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Operational stock of a part at a property (Spec §10.8: usage and stock, not purchasing). */
export const parts = classify(
  eng.table(
    'parts',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      partNumber: varchar('part_number', { length: 60 }).notNull(),
      name: varchar('name', { length: 200 }).notNull(),
      unit: varchar('unit', { length: 16 }).notNull().default('EA'),
      onHand: numeric('on_hand', { precision: 12, scale: 2, mode: 'number' }).notNull().default(0),
      reorderLevel: numeric('reorder_level', { precision: 12, scale: 2, mode: 'number' })
        .notNull()
        .default(0),
      ...versioned(),
    },
    (t) => [uniqueIndex('parts_number_uq').on(t.propertyId, t.partNumber)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    partNumber: 'INTERNAL',
    name: 'INTERNAL',
    unit: 'INTERNAL',
    onHand: 'INTERNAL',
    reorderLevel: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A part used on a work order, or stock received (negative usage is not allowed; receipts are their own rows). */
export const partMovements = classify(
  eng.table(
    'part_movements',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      partId: uuid('part_id')
        .notNull()
        .references(() => parts.id, { onDelete: 'restrict' }),
      workOrderId: uuid('work_order_id').references(() => workOrders.id, { onDelete: 'restrict' }),
      kind: varchar('kind', { length: 16 }).notNull(),
      quantity: numeric('quantity', { precision: 12, scale: 2, mode: 'number' }).notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (t) => [
      index('part_movements_part_idx').on(t.partId, t.occurredAt),
      index('part_movements_work_order_idx').on(t.workOrderId),
    ],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    partId: 'INTERNAL',
    workOrderId: 'INTERNAL',
    kind: 'INTERNAL',
    quantity: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    occurredAt: 'INTERNAL',
  },
);

export const warrantyStatus = eng.enum('warranty_status', [
  'SUGGESTED',
  'OPENED',
  'CLOSED',
  'DISMISSED',
]);

/** A failure of equipment still under warranty: the vendor may owe the repair (Spec §10.9). */
export const warrantyCases = classify(
  eng.table(
    'warranty_cases',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      workOrderId: uuid('work_order_id')
        .notNull()
        .references(() => workOrders.id, { onDelete: 'restrict' }),
      assetId: uuid('asset_id')
        .notNull()
        .references(() => assets.id, { onDelete: 'restrict' }),
      warrantyUntil: date('warranty_until', { mode: 'string' }).notNull(),
      status: warrantyStatus('status').notNull().default('SUGGESTED'),
      note: varchar('note', { length: 500 }),
      ...versioned(),
    },
    (t) => [uniqueIndex('warranty_cases_work_order_uq').on(t.workOrderId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    workOrderId: 'INTERNAL',
    assetId: 'INTERNAL',
    warrantyUntil: 'INTERNAL',
    status: 'INTERNAL',
    note: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type WorkOrderRow = typeof workOrders.$inferSelect;
export type PartRow = typeof parts.$inferSelect;
export type WarrantyCaseRow = typeof warrantyCases.$inferSelect;
