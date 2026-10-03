import { sql } from 'drizzle-orm';
import {
  customType,
  date,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';

/**
 * Knowledge (Spec §37–§38, BUILD_PLAN 6.D, schema `knowledge`): hotel documents scoped to a tenant or one property,
 * versioned (published versions immutable), chunked for retrieval with a normalized keyword index and embeddings.
 */
export const knowledge = pgSchema('knowledge');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** pgvector without a fixed dimension: embeddings of different models may coexist (filtered by model). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const documentKind = knowledge.enum('document_kind', [
  'POLICY',
  'FAQ',
  'MENU',
  'MANUAL',
  'GENERAL',
]);
export const documentStatus = knowledge.enum('document_status', ['ACTIVE', 'ARCHIVED']);
export const versionStatus = knowledge.enum('version_status', ['DRAFT', 'PUBLISHED', 'SUPERSEDED']);
export const audience = knowledge.enum('audience', ['GUEST', 'STAFF', 'ALL']);
export const classification = knowledge.enum('classification', [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
]);

export const documents = classify(
  knowledge.table(
    'documents',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      /** Null: the document applies to every property of the tenant. */
      propertyId: uuid('property_id'),
      kind: documentKind('kind').notNull(),
      title: varchar('title', { length: 200 }).notNull(),
      status: documentStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [index('documents_scope_idx').on(t.tenantId, t.propertyId, t.status)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    kind: 'INTERNAL',
    title: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A version of a document in one language; its classification bounds who (and which model) may read it. */
export const documentVersions = classify(
  knowledge.table(
    'document_versions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      documentId: uuid('document_id')
        .notNull()
        .references(() => documents.id, { onDelete: 'restrict' }),
      versionNo: integer('version_no').notNull(),
      status: versionStatus('status').notNull().default('DRAFT'),
      language: varchar('language', { length: 8 }).notNull(),
      audience: audience('audience').notNull(),
      classification: classification('classification').notNull(),
      departmentCode: varchar('department_code', { length: 32 }),
      effectiveFrom: date('effective_from', { mode: 'string' }),
      effectiveUntil: date('effective_until', { mode: 'string' }),
      body: text('body').notNull(),
      publishedAt: tz('published_at'),
    },
    (t) => [
      unique('document_versions_no_uq').on(t.documentId, t.versionNo),
      uniqueIndex('document_versions_published_uq')
        .on(t.documentId, t.language)
        .where(sql`${t.status} = 'PUBLISHED'`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    documentId: 'INTERNAL',
    versionNo: 'INTERNAL',
    status: 'INTERNAL',
    language: 'INTERNAL',
    audience: 'INTERNAL',
    classification: 'INTERNAL',
    departmentCode: 'INTERNAL',
    effectiveFrom: 'INTERNAL',
    effectiveUntil: 'INTERNAL',
    body: 'CONFIDENTIAL',
    publishedAt: 'INTERNAL',
  },
);

/** A retrievable piece of a published version; `search` is the generated keyword index of the normalized text. */
export const chunks = classify(
  knowledge.table(
    'chunks',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      versionId: uuid('version_id')
        .notNull()
        .references(() => documentVersions.id, { onDelete: 'restrict' }),
      seq: integer('seq').notNull(),
      text: text('text').notNull(),
      normalized: text('normalized').notNull(),
      search: tsvector('search')
        .notNull()
        .generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, normalized)`),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      unique('chunks_version_seq_uq').on(t.versionId, t.seq),
      index('chunks_search_idx').using('gin', t.search),
    ],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    versionId: 'INTERNAL',
    seq: 'INTERNAL',
    text: 'CONFIDENTIAL',
    normalized: 'CONFIDENTIAL',
    search: 'CONFIDENTIAL',
    createdAt: 'INTERNAL',
  },
);

export const chunkEmbeddings = classify(
  knowledge.table(
    'chunk_embeddings',
    {
      chunkId: uuid('chunk_id')
        .notNull()
        .references(() => chunks.id, { onDelete: 'restrict' }),
      tenantId: uuid('tenant_id').notNull(),
      modelCode: varchar('model_code', { length: 128 }).notNull(),
      dims: integer('dims').notNull(),
      embedding: vector('embedding').notNull(),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ name: 'chunk_embeddings_pk', columns: [t.chunkId, t.modelCode] }),
      index('chunk_embeddings_model_idx').on(t.tenantId, t.modelCode),
    ],
  ),
  {
    chunkId: 'INTERNAL',
    tenantId: 'INTERNAL',
    modelCode: 'INTERNAL',
    dims: 'INTERNAL',
    embedding: 'CONFIDENTIAL',
    createdAt: 'INTERNAL',
  },
);

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type ChunkRow = typeof chunks.$inferSelect;
