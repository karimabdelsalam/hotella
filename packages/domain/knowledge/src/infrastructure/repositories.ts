import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, notExists, or, type SQL, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  type ChunkRow,
  chunkEmbeddings,
  chunks,
  type DocumentRow,
  documents,
  type DocumentVersionRow,
  documentVersions,
} from './schema';

/** What a search may see (BUILD_PLAN 6.D): scope, audience, classification, effective date, language, department. */
export interface CandidateFilter {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly audience: 'GUEST' | 'STAFF';
  readonly classifications: readonly string[];
  readonly today: string;
  readonly language: string | null;
  readonly departmentCode: string | null;
  /** Only these documents (e.g. the manuals linked to one asset); null for every document in scope. */
  readonly documentIds: readonly string[] | null;
}

@Injectable()
export class KnowledgeRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- documents ----
  async insertDocument(values: typeof documents.$inferInsert): Promise<DocumentRow> {
    const [row] = await this.x.insert(documents).values(values).returning();
    return row!;
  }
  async document(scope: TenantScope, id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.x
      .select()
      .from(documents)
      .where(tenantWhere(documents, scope, eq(documents.id, id)));
    return row;
  }
  async documentForUpdate(scope: TenantScope, id: string): Promise<DocumentRow | undefined> {
    const [row] = await this.x
      .select()
      .from(documents)
      .where(tenantWhere(documents, scope, eq(documents.id, id)))
      .for('update');
    return row;
  }
  async updateDocument(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<DocumentRow, 'status' | 'title'>>,
  ): Promise<DocumentRow> {
    const [row] = await this.x
      .update(documents)
      .set({ ...patch, updatedAt: new Date(), version: sql`${documents.version} + 1` })
      .where(tenantWhere(documents, scope, eq(documents.id, id)))
      .returning();
    return row!;
  }
  /** The property's documents and the tenant-wide ones. */
  documentsVisibleAt(scope: PropertyScope): Promise<DocumentRow[]> {
    return this.x
      .select()
      .from(documents)
      .where(
        tenantWhere(
          documents,
          scope,
          or(eq(documents.propertyId, scope.propertyId), isNull(documents.propertyId)),
        ),
      )
      .orderBy(asc(documents.title));
  }

  // ---- versions ----
  async insertVersion(values: typeof documentVersions.$inferInsert): Promise<DocumentVersionRow> {
    const [row] = await this.x.insert(documentVersions).values(values).returning();
    return row!;
  }
  async nextVersionNo(scope: TenantScope, documentId: string): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`coalesce(max(${documentVersions.versionNo}), 0)::int` })
      .from(documentVersions)
      .where(tenantWhere(documentVersions, scope, eq(documentVersions.documentId, documentId)));
    return (row?.n ?? 0) + 1;
  }
  async versionForUpdate(scope: TenantScope, id: string): Promise<DocumentVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(documentVersions)
      .where(tenantWhere(documentVersions, scope, eq(documentVersions.id, id)))
      .for('update');
    return row;
  }
  async version(scope: TenantScope, id: string): Promise<DocumentVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(documentVersions)
      .where(tenantWhere(documentVersions, scope, eq(documentVersions.id, id)));
    return row;
  }
  versionsOf(scope: TenantScope, documentIds: readonly string[]) {
    if (documentIds.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        id: documentVersions.id,
        documentId: documentVersions.documentId,
        versionNo: documentVersions.versionNo,
        status: documentVersions.status,
        language: documentVersions.language,
        audience: documentVersions.audience,
        classification: documentVersions.classification,
        departmentCode: documentVersions.departmentCode,
        effectiveFrom: documentVersions.effectiveFrom,
        effectiveUntil: documentVersions.effectiveUntil,
        publishedAt: documentVersions.publishedAt,
      })
      .from(documentVersions)
      .where(
        tenantWhere(
          documentVersions,
          scope,
          inArray(documentVersions.documentId, [...documentIds]),
        ),
      )
      .orderBy(asc(documentVersions.documentId), asc(documentVersions.versionNo));
  }
  /** Publishes a draft, superseding the published version of the same document and language. */
  async publish(
    scope: TenantScope,
    version: DocumentVersionRow,
    at: Date,
  ): Promise<DocumentVersionRow> {
    await this.x
      .update(documentVersions)
      .set({ status: 'SUPERSEDED', updatedAt: at })
      .where(
        tenantWhere(
          documentVersions,
          scope,
          eq(documentVersions.documentId, version.documentId),
          eq(documentVersions.language, version.language),
          eq(documentVersions.status, 'PUBLISHED'),
        ),
      );
    const [row] = await this.x
      .update(documentVersions)
      .set({ status: 'PUBLISHED', publishedAt: at, updatedAt: at })
      .where(tenantWhere(documentVersions, scope, eq(documentVersions.id, version.id)))
      .returning();
    return row!;
  }

  // ---- chunks and embeddings ----
  async insertChunks(values: Array<Omit<typeof chunks.$inferInsert, 'search'>>): Promise<void> {
    if (values.length > 0) await this.x.insert(chunks).values(values);
  }
  /** Chunks of published versions that have no embedding yet (any model), oldest first. */
  chunksToEmbed(scope: TenantScope | null, limit: number, versionId?: string) {
    const conditions: SQL[] = [
      eq(documentVersions.status, 'PUBLISHED'),
      notExists(
        this.x
          .select({ one: sql`1` })
          .from(chunkEmbeddings)
          .where(eq(chunkEmbeddings.chunkId, chunks.id)),
      ),
    ];
    if (versionId) conditions.push(eq(chunks.versionId, versionId));
    return this.x
      .select({
        id: chunks.id,
        tenantId: chunks.tenantId,
        text: chunks.text,
        classification: documentVersions.classification,
        propertyId: documents.propertyId,
      })
      .from(chunks)
      .innerJoin(documentVersions, eq(documentVersions.id, chunks.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(scope ? tenantWhere(chunks, scope, ...conditions) : and(...conditions))
      .orderBy(asc(chunks.id))
      .limit(limit);
  }
  async insertEmbeddings(values: Array<typeof chunkEmbeddings.$inferInsert>): Promise<void> {
    if (values.length > 0)
      await this.x.insert(chunkEmbeddings).values(values).onConflictDoNothing();
  }

  // ---- retrieval ----
  private candidates(f: CandidateFilter): SQL {
    return sql`${chunks.tenantId} = ${f.tenantId}
      and ${documentVersions.status} = 'PUBLISHED' and ${documents.status} = 'ACTIVE'
      and (${documents.propertyId} = ${f.propertyId} or ${documents.propertyId} is null)
      and ${documentVersions.audience} in (${f.audience}, 'ALL')
      and ${documentVersions.classification}::text in (${sql.join(
        f.classifications.map((c) => sql`${c}`),
        sql`, `,
      )})
      and (${documentVersions.effectiveFrom} is null or ${documentVersions.effectiveFrom} <= ${f.today})
      and (${documentVersions.effectiveUntil} is null or ${documentVersions.effectiveUntil} >= ${f.today})
      ${f.language ? sql`and ${documentVersions.language} = ${f.language}` : sql``}
      ${
        f.departmentCode
          ? sql`and (${documentVersions.departmentCode} is null or ${documentVersions.departmentCode} = ${f.departmentCode})`
          : sql``
      }
      ${
        f.documentIds
          ? f.documentIds.length > 0
            ? sql`and ${documents.id} in (${sql.join(
                f.documentIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`
            : sql`and false`
          : sql``
      }`;
  }
  /** Keyword candidates: any of the normalized terms, ranked by cover density. */
  async keyword(f: CandidateFilter, terms: readonly string[], limit: number): Promise<string[]> {
    if (terms.length === 0) return [];
    const query = sql`to_tsquery('simple', ${terms.join(' | ')})`;
    const rows = await this.x
      .select({ id: chunks.id })
      .from(chunks)
      .innerJoin(documentVersions, eq(documentVersions.id, chunks.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(sql`${this.candidates(f)} and ${chunks.search} @@ ${query}`)
      .orderBy(sql`ts_rank_cd(${chunks.search}, ${query}) desc`, asc(chunks.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }
  /**
   * Vector candidates: nearest by cosine distance among embeddings of the same model and dimension, within
   * `maxDistance` (nearest-neighbour search always finds something; unrelated text must not count as a match).
   */
  async nearest(
    f: CandidateFilter,
    query: readonly number[],
    modelCode: string,
    limit: number,
    maxDistance: number,
  ): Promise<string[]> {
    const vec = `[${query.join(',')}]`;
    const rows = await this.x
      .select({ id: chunks.id })
      .from(chunks)
      .innerJoin(documentVersions, eq(documentVersions.id, chunks.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .innerJoin(chunkEmbeddings, eq(chunkEmbeddings.chunkId, chunks.id))
      .where(
        sql`${this.candidates(f)} and ${chunkEmbeddings.modelCode} = ${modelCode} and ${chunkEmbeddings.dims} = ${query.length}
          and (${chunkEmbeddings.embedding} <=> ${vec}::vector) <= ${maxDistance}`,
      )
      .orderBy(sql`${chunkEmbeddings.embedding} <=> ${vec}::vector`, asc(chunks.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }
  passages(scope: TenantScope, ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        chunkId: chunks.id,
        text: chunks.text,
        versionId: documentVersions.id,
        versionNo: documentVersions.versionNo,
        language: documentVersions.language,
        documentId: documents.id,
        title: documents.title,
        kind: documents.kind,
      })
      .from(chunks)
      .innerJoin(documentVersions, eq(documentVersions.id, chunks.versionId))
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .where(tenantWhere(chunks, scope, inArray(chunks.id, [...ids])));
  }
}

export type { ChunkRow };
