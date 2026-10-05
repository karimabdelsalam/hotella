import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
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
import { TELEMETRY_QUANTITIES, TELEMETRY_RULE_KINDS } from '@hotella/contracts-events';
import type { PmTrigger } from '../domain/pm';
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
  'TELEMETRY',
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
      /** Preventive work: the plan that created it and the published procedure version it follows. */
      pmPlanId: uuid('pm_plan_id'),
      procedureVersionId: uuid('procedure_version_id'),
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
    pmPlanId: 'INTERNAL',
    procedureVersionId: 'INTERNAL',
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

// ---- meters and preventive maintenance (Spec §10.6–§10.7, BUILD_PLAN 8.3) ----

export const meterKind = eng.enum('meter_kind', [
  'RUNTIME_HOURS',
  'CYCLES',
  'ENERGY_KWH',
  'TEMPERATURE',
  'PRESSURE',
]);
export const readingSource = eng.enum('reading_source', ['STAFF', 'IOT', 'BMS', 'API']);

export const meters = classify(
  eng.table(
    'meters',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      assetId: uuid('asset_id')
        .notNull()
        .references(() => assets.id, { onDelete: 'restrict' }),
      kind: meterKind('kind').notNull(),
      unit: varchar('unit', { length: 16 }).notNull(),
      lastValue: numeric('last_value', { precision: 14, scale: 3, mode: 'number' }),
      lastReadAt: timestamp('last_read_at', { withTimezone: true, mode: 'date' }),
    },
    (t) => [uniqueIndex('meters_asset_kind_uq').on(t.assetId, t.kind)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    assetId: 'INTERNAL',
    kind: 'INTERNAL',
    unit: 'INTERNAL',
    lastValue: 'INTERNAL',
    lastReadAt: 'INTERNAL',
  },
);

/** Every reading as it came (append-only); a meter replacement is a reading with `reset`. */
export const meterReadings = classify(
  eng.table(
    'meter_readings',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      meterId: uuid('meter_id')
        .notNull()
        .references(() => meters.id, { onDelete: 'restrict' }),
      value: numeric('value', { precision: 14, scale: 3, mode: 'number' }).notNull(),
      reset: boolean('reset').notNull().default(false),
      source: readingSource('source').notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (t) => [index('meter_readings_meter_idx').on(t.meterId, t.readAt)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    meterId: 'INTERNAL',
    value: 'INTERNAL',
    reset: 'INTERNAL',
    source: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    readAt: 'INTERNAL',
  },
);

export const procedureStatus = eng.enum('procedure_status', ['DRAFT', 'PUBLISHED']);

/** A maintenance procedure (checklist) of the tenant; its published versions never change (rule 9). */
export const pmProcedures = classify(
  eng.table(
    'pm_procedures',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      code: varchar('code', { length: 40 }).notNull(),
      title: varchar('title', { length: 200 }).notNull(),
    },
    (t) => [uniqueIndex('pm_procedures_code_uq').on(t.tenantId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    code: 'INTERNAL',
    title: 'INTERNAL',
  },
);

export interface ProcedureStep {
  readonly text: string;
  readonly requiresReading?: boolean;
}

export const pmProcedureVersions = classify(
  eng.table(
    'pm_procedure_versions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      procedureId: uuid('procedure_id')
        .notNull()
        .references(() => pmProcedures.id, { onDelete: 'restrict' }),
      versionNo: integer('version_no').notNull(),
      status: procedureStatus('status').notNull().default('DRAFT'),
      steps: jsonb('steps').$type<ProcedureStep[]>().notNull(),
      estimatedMinutes: integer('estimated_minutes'),
      publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    },
    (t) => [uniqueIndex('pm_procedure_versions_uq').on(t.procedureId, t.versionNo)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    procedureId: 'INTERNAL',
    versionNo: 'INTERNAL',
    status: 'INTERNAL',
    steps: 'INTERNAL',
    estimatedMinutes: 'INTERNAL',
    publishedAt: 'INTERNAL',
  },
);

/** When an asset gets preventive work and by which procedure (Spec §10.7). */
export const pmPlans = classify(
  eng.table(
    'pm_plans',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      assetId: uuid('asset_id')
        .notNull()
        .references(() => assets.id, { onDelete: 'restrict' }),
      procedureId: uuid('procedure_id')
        .notNull()
        .references(() => pmProcedures.id, { onDelete: 'restrict' }),
      trigger: jsonb('trigger').$type<PmTrigger>().notNull(),
      leadDays: integer('lead_days').notNull().default(0),
      lastDoneOn: date('last_done_on', { mode: 'string' }).notNull(),
      lastDoneValue: numeric('last_done_value', { precision: 14, scale: 3, mode: 'number' }),
      /** The open preventive work order, so a plan never has two at once. */
      openWorkOrderId: uuid('open_work_order_id'),
      active: boolean('active').notNull().default(true),
      ...versioned(),
    },
    (t) => [index('pm_plans_property_idx').on(t.tenantId, t.propertyId, t.active)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    assetId: 'INTERNAL',
    procedureId: 'INTERNAL',
    trigger: 'INTERNAL',
    leadDays: 'INTERNAL',
    lastDoneOn: 'INTERNAL',
    lastDoneValue: 'INTERNAL',
    openWorkOrderId: 'INTERNAL',
    active: 'INTERNAL',
    version: 'INTERNAL',
  },
);

// ---- room restrictions (Spec §10.10) ----

export const restrictionKind = eng.enum('restriction_kind', [
  'OOO',
  'OOS',
  'BLOCKED_OPERATIONALLY',
]);
export const pmsSyncStatus = eng.enum('pms_sync_status', [
  'NOT_REQUIRED',
  'PENDING',
  'SENT',
  'FAILED',
]);

/** A room that must not be sold or used, with history (released rows stay). */
export const roomRestrictions = classify(
  eng.table(
    'room_restrictions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      roomId: uuid('room_id').notNull(),
      kind: restrictionKind('kind').notNull(),
      reason: varchar('reason', { length: 300 }).notNull(),
      startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
      endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }),
      workOrderId: uuid('work_order_id').references(() => workOrders.id, { onDelete: 'restrict' }),
      pmsSync: pmsSyncStatus('pms_sync').notNull().default('NOT_REQUIRED'),
      createdByType: varchar('created_by_type', { length: 16 }).notNull(),
      createdById: uuid('created_by_id'),
      releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
      releasedByType: varchar('released_by_type', { length: 16 }),
      releasedById: uuid('released_by_id'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('room_restrictions_open_uq')
        .on(t.roomId)
        .where(sql`${t.releasedAt} is null`),
      index('room_restrictions_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    roomId: 'INTERNAL',
    kind: 'INTERNAL',
    reason: 'INTERNAL',
    startsAt: 'INTERNAL',
    endsAt: 'INTERNAL',
    workOrderId: 'INTERNAL',
    pmsSync: 'INTERNAL',
    createdByType: 'INTERNAL',
    createdById: 'INTERNAL',
    releasedAt: 'INTERNAL',
    releasedByType: 'INTERNAL',
    releasedById: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type MeterRow = typeof meters.$inferSelect;
export type PmProcedureVersionRow = typeof pmProcedureVersions.$inferSelect;
export type PmPlanRow = typeof pmPlans.$inferSelect;
export type RoomRestrictionRow = typeof roomRestrictions.$inferSelect;
export type PartRow = typeof parts.$inferSelect;
export type WarrantyCaseRow = typeof warrantyCases.$inferSelect;

// ---- building telemetry (ADR-0024, BUILD_PLAN 13.2) ----

export const telemetryQuantity = eng.enum('telemetry_quantity', TELEMETRY_QUANTITIES);
export const telemetryPointStatus = eng.enum('telemetry_point_status', ['ACTIVE', 'IGNORED']);
export const telemetryRuleKind = eng.enum('telemetry_rule_kind', TELEMETRY_RULE_KINDS);
export const telemetrySeverity = eng.enum('telemetry_severity', ['WARNING', 'CRITICAL']);
export const telemetryAction = eng.enum('telemetry_action', ['ALERT', 'WORK_ORDER']);
export const telemetryRuleStatus = eng.enum('telemetry_rule_status', ['ACTIVE', 'RETIRED']);
export const telemetryAlarmStatus = eng.enum('telemetry_alarm_status', [
  'OPEN',
  'ACKNOWLEDGED',
  'CLEARED',
]);

/**
 * An external point (a BMS point, a sensor) of a telemetry integration, and what it measures here: this registry is
 * the point mapping (an unknown point code is an integration exception, never guessed — rule 16).
 */
export const telemetryPoints = classify(
  eng.table(
    'telemetry_points',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id').notNull(),
      externalCode: varchar('external_code', { length: 64 }).notNull(),
      name: varchar('name', { length: 200 }),
      assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'restrict' }),
      locationId: uuid('location_id'),
      quantity: telemetryQuantity('quantity').notNull(),
      unit: varchar('unit', { length: 16 }).notNull(),
      status: telemetryPointStatus('status').notNull().default('ACTIVE'),
      lastValue: doublePrecision('last_value'),
      lastAt: timestamp('last_at', { withTimezone: true, mode: 'date' }),
      createdBy: uuid('created_by'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('telemetry_points_code_uq').on(t.instanceId, t.externalCode),
      index('telemetry_points_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    externalCode: 'INTERNAL',
    name: 'INTERNAL',
    assetId: 'INTERNAL',
    locationId: 'INTERNAL',
    quantity: 'INTERNAL',
    unit: 'INTERNAL',
    status: 'INTERNAL',
    lastValue: 'INTERNAL',
    lastAt: 'INTERNAL',
    createdBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * One row per point and minute (raw samples are not kept): range-partitioned by month in the migration, retention
 * 400 days (`eng.maintain_telemetry_partitions`).
 */
export const telemetryMinutes = classify(
  eng.table(
    'telemetry_minutes',
    {
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      pointId: uuid('point_id')
        .notNull()
        .references(() => telemetryPoints.id, { onDelete: 'restrict' }),
      minute: timestamp('minute', { withTimezone: true, mode: 'date' }).notNull(),
      min: doublePrecision('min').notNull(),
      max: doublePrecision('max').notNull(),
      sum: doublePrecision('sum').notNull(),
      samples: integer('samples').notNull(),
      last: doublePrecision('last').notNull(),
      lastAt: timestamp('last_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (t) => [primaryKey({ name: 'telemetry_minutes_pk', columns: [t.pointId, t.minute] })],
  ),
  {
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    pointId: 'INTERNAL',
    minute: 'INTERNAL',
    min: 'INTERNAL',
    max: 'INTERNAL',
    sum: 'INTERNAL',
    samples: 'INTERNAL',
    last: 'INTERNAL',
    lastAt: 'INTERNAL',
  },
);

/** A deterministic rule on one point (rule 11). Immutable once created (rule 9): retire it and create another. */
export const telemetryRules = classify(
  eng.table(
    'telemetry_rules',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      pointId: uuid('point_id')
        .notNull()
        .references(() => telemetryPoints.id, { onDelete: 'restrict' }),
      kind: telemetryRuleKind('kind').notNull(),
      params: jsonb('params').$type<Record<string, number>>().notNull(),
      severity: telemetrySeverity('severity').notNull(),
      action: telemetryAction('action').notNull(),
      status: telemetryRuleStatus('status').notNull().default('ACTIVE'),
      createdBy: uuid('created_by'),
      retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
      retiredBy: uuid('retired_by'),
      ...versioned(),
    },
    (t) => [index('telemetry_rules_point_idx').on(t.pointId, t.status)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    pointId: 'INTERNAL',
    kind: 'INTERNAL',
    params: 'INTERNAL',
    severity: 'INTERNAL',
    action: 'INTERNAL',
    status: 'INTERNAL',
    createdBy: 'INTERNAL',
    retiredAt: 'INTERNAL',
    retiredBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** One live alarm per rule at a time; cleared alarms stay as history (rule 10). */
export const telemetryAlarms = classify(
  eng.table(
    'telemetry_alarms',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      pointId: uuid('point_id')
        .notNull()
        .references(() => telemetryPoints.id, { onDelete: 'restrict' }),
      ruleId: uuid('rule_id')
        .notNull()
        .references(() => telemetryRules.id, { onDelete: 'restrict' }),
      status: telemetryAlarmStatus('status').notNull().default('OPEN'),
      raisedAt: timestamp('raised_at', { withTimezone: true, mode: 'date' }).notNull(),
      value: doublePrecision('value'),
      peak: doublePrecision('peak'),
      acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
      acknowledgedBy: uuid('acknowledged_by'),
      clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
      workOrderId: uuid('work_order_id').references(() => workOrders.id, { onDelete: 'restrict' }),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('telemetry_alarms_live_uq')
        .on(t.ruleId)
        .where(sql`${t.status} <> 'CLEARED'`),
      index('telemetry_alarms_property_idx').on(t.tenantId, t.propertyId, t.status),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    pointId: 'INTERNAL',
    ruleId: 'INTERNAL',
    status: 'INTERNAL',
    raisedAt: 'INTERNAL',
    value: 'INTERNAL',
    peak: 'INTERNAL',
    acknowledgedAt: 'INTERNAL',
    acknowledgedBy: 'INTERNAL',
    clearedAt: 'INTERNAL',
    workOrderId: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type TelemetryPointRow = typeof telemetryPoints.$inferSelect;
export type TelemetryMinuteRow = typeof telemetryMinutes.$inferSelect;
export type TelemetryRuleRow = typeof telemetryRules.$inferSelect;
export type TelemetryAlarmRow = typeof telemetryAlarms.$inferSelect;
