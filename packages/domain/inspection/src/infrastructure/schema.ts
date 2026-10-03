import {
  boolean,
  index,
  integer,
  jsonb,
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
import type { Answer, ItemRule } from '../domain/checklist';

/**
 * The generic inspection engine (Spec §11, BUILD_PLAN Phase 9, schema `inspection`). Checklists are tenant-wide
 * templates with versions that never change once published (rule 9); an inspection pins the version it ran on.
 */
export const inspection = pgSchema('inspection');

export const templateScope = inspection.enum('template_scope', ['ROOM', 'AREA', 'ASSET']);
export const versionStatus = inspection.enum('version_status', ['DRAFT', 'PUBLISHED']);
export const inspectionSource = inspection.enum('inspection_source', [
  'STAFF',
  'SCHEDULE',
  'HK_JOB',
  'WORK_ORDER',
]);
export const inspectionStatus = inspection.enum('inspection_status', [
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);
export const inspectionResult = inspection.enum('inspection_result', ['PASS', 'FAIL']);
export const findingSeverity = inspection.enum('finding_severity', [
  'INFO',
  'MINOR',
  'MAJOR',
  'CRITICAL',
]);
export const findingStatus = inspection.enum('finding_status', ['OPEN', 'LINKED', 'RESOLVED']);

/** A checklist (room cleanliness, pool safety, fire equipment…) and the department its findings go to. */
export const templates = classify(
  inspection.table(
    'templates',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      code: varchar('code', { length: 40 }).notNull(),
      scope: templateScope('scope').notNull(),
      departmentCode: varchar('department_code', { length: 32 }).notNull(),
      active: boolean('active').notNull().default(true),
      ...versioned(),
    },
    (t) => [uniqueIndex('templates_code_uq').on(t.tenantId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    code: 'INTERNAL',
    scope: 'INTERNAL',
    departmentCode: 'INTERNAL',
    active: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const templateTranslations = classify(
  inspection.table(
    'template_translations',
    { ...translationColumns(() => templates.id), name: text('name').notNull() },
    (t) => [translationUnique('template_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** One version of a checklist: a draft while it is written, immutable once published. */
export const templateVersions = classify(
  inspection.table(
    'template_versions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      templateId: uuid('template_id')
        .notNull()
        .references(() => templates.id, { onDelete: 'restrict' }),
      versionNo: integer('version_no').notNull(),
      status: versionStatus('status').notNull().default('DRAFT'),
      publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
      publishedById: uuid('published_by_id'),
    },
    (t) => [uniqueIndex('template_versions_no_uq').on(t.templateId, t.versionNo)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    templateId: 'INTERNAL',
    versionNo: 'INTERNAL',
    status: 'INTERNAL',
    publishedAt: 'INTERNAL',
    publishedById: 'INTERNAL',
  },
);

export const templateSections = classify(
  inspection.table(
    'template_sections',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      versionId: uuid('version_id')
        .notNull()
        .references(() => templateVersions.id, { onDelete: 'cascade' }),
      code: varchar('code', { length: 40 }).notNull(),
      position: integer('position').notNull(),
    },
    (t) => [uniqueIndex('template_sections_code_uq').on(t.versionId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    versionId: 'INTERNAL',
    code: 'INTERNAL',
    position: 'INTERNAL',
  },
);

export const templateSectionTranslations = classify(
  inspection.table(
    'template_section_translations',
    { ...translationColumns(() => templateSections.id), title: text('title').notNull() },
    (t) => [translationUnique('template_section_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    title: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** A checklist item: how it is answered and judged (`ItemRule`, deterministic) and its place in the version. */
export const templateItems = classify(
  inspection.table(
    'template_items',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      versionId: uuid('version_id')
        .notNull()
        .references(() => templateVersions.id, { onDelete: 'cascade' }),
      sectionId: uuid('section_id')
        .notNull()
        .references(() => templateSections.id, { onDelete: 'cascade' }),
      code: varchar('code', { length: 40 }).notNull(),
      position: integer('position').notNull(),
      rule: jsonb('rule').$type<ItemRule>().notNull(),
    },
    (t) => [uniqueIndex('template_items_code_uq').on(t.versionId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    versionId: 'INTERNAL',
    sectionId: 'INTERNAL',
    code: 'INTERNAL',
    position: 'INTERNAL',
    rule: 'INTERNAL',
  },
);

export const templateItemTranslations = classify(
  inspection.table(
    'template_item_translations',
    {
      ...translationColumns(() => templateItems.id),
      label: text('label').notNull(),
      help: text('help'),
      /** Labels of a multi-select item's options, by option code. */
      optionLabels: jsonb('option_labels').$type<Record<string, string>>().notNull().default({}),
    },
    (t) => [translationUnique('template_item_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    label: 'INTERNAL',
    help: 'INTERNAL',
    optionLabels: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** One inspection at a place (and optionally on an asset), pinned to the published version it started on. */
export const inspections = classify(
  inspection.table(
    'inspections',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      number: integer('number').notNull(),
      templateId: uuid('template_id')
        .notNull()
        .references(() => templates.id, { onDelete: 'restrict' }),
      templateVersionId: uuid('template_version_id')
        .notNull()
        .references(() => templateVersions.id, { onDelete: 'restrict' }),
      locationId: uuid('location_id').notNull(),
      assetId: uuid('asset_id'),
      source: inspectionSource('source').notNull(),
      sourceRef: varchar('source_ref', { length: 64 }),
      status: inspectionStatus('status').notNull().default('IN_PROGRESS'),
      inspectorType: varchar('inspector_type', { length: 16 }).notNull(),
      inspectorId: uuid('inspector_id'),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      score: integer('score'),
      result: inspectionResult('result'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('inspections_number_uq').on(t.propertyId, t.number),
      index('inspections_location_idx').on(t.tenantId, t.propertyId, t.locationId),
      index('inspections_status_idx').on(t.tenantId, t.propertyId, t.status),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    number: 'INTERNAL',
    templateId: 'INTERNAL',
    templateVersionId: 'INTERNAL',
    locationId: 'INTERNAL',
    assetId: 'INTERNAL',
    source: 'INTERNAL',
    sourceRef: 'INTERNAL',
    status: 'INTERNAL',
    inspectorType: 'INTERNAL',
    inspectorId: 'INTERNAL',
    startedAt: 'INTERNAL',
    completedAt: 'INTERNAL',
    score: 'INTERNAL',
    result: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every answer as given (append-only; the latest per item counts), with the inspector's note. */
export const responses = classify(
  inspection.table(
    'responses',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      inspectionId: uuid('inspection_id')
        .notNull()
        .references(() => inspections.id, { onDelete: 'restrict' }),
      itemId: uuid('item_id')
        .notNull()
        .references(() => templateItems.id, { onDelete: 'restrict' }),
      answer: jsonb('answer').$type<Answer>().notNull(),
      /** The inspector's own words (may describe a guest's belongings: CONFIDENTIAL). */
      note: text('note'),
      answeredByType: varchar('answered_by_type', { length: 16 }).notNull(),
      answeredById: uuid('answered_by_id'),
    },
    (t) => [index('responses_inspection_idx').on(t.inspectionId, t.itemId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    inspectionId: 'INTERNAL',
    itemId: 'INTERNAL',
    answer: 'INTERNAL',
    note: 'CONFIDENTIAL',
    answeredByType: 'INTERNAL',
    answeredById: 'INTERNAL',
  },
);

/** A failed item: its severity and, when work was opened for it, the work item. */
export const findings = classify(
  inspection.table(
    'findings',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      inspectionId: uuid('inspection_id')
        .notNull()
        .references(() => inspections.id, { onDelete: 'restrict' }),
      itemId: uuid('item_id')
        .notNull()
        .references(() => templateItems.id, { onDelete: 'restrict' }),
      severity: findingSeverity('severity').notNull(),
      status: findingStatus('status').notNull().default('OPEN'),
      workItemId: uuid('work_item_id'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('findings_item_uq').on(t.inspectionId, t.itemId),
      index('findings_status_idx').on(t.tenantId, t.propertyId, t.status),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    inspectionId: 'INTERNAL',
    itemId: 'INTERNAL',
    severity: 'INTERNAL',
    status: 'INTERNAL',
    workItemId: 'INTERNAL',
    resolvedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type TemplateRow = typeof templates.$inferSelect;
export type TemplateVersionRow = typeof templateVersions.$inferSelect;
export type TemplateSectionRow = typeof templateSections.$inferSelect;
export type TemplateItemRow = typeof templateItems.$inferSelect;
export type InspectionRow = typeof inspections.$inferSelect;
export type ResponseRow = typeof responses.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
