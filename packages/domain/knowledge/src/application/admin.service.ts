import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { KnowledgeRepositories } from '../infrastructure/repositories';
import type { DocumentRow } from '../infrastructure/schema';
import { KnowledgeIndexer } from './indexer';
import { KnowledgeRetriever } from './retriever';

const isoDate = z.iso.date();

export const createDocumentSchema = z.object({
  kind: z.enum(['POLICY', 'FAQ', 'MENU', 'MANUAL', 'GENERAL']),
  title: z.string().trim().min(1).max(200),
  /** Applies to every property of the tenant (needs tenant-wide `knowledge.manage`). */
  tenantWide: z.boolean().default(false),
});
export const createVersionSchema = z
  .object({
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
    audience: z.enum(['GUEST', 'STAFF', 'ALL']),
    classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']),
    departmentCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,31}$/)
      .nullish(),
    effectiveFrom: isoDate.nullish(),
    effectiveUntil: isoDate.nullish(),
    body: z.string().trim().min(1).max(200_000),
  })
  .refine((v) => !v.effectiveFrom || !v.effectiveUntil || v.effectiveFrom <= v.effectiveUntil, {
    path: ['effectiveUntil'],
    message: 'effectiveUntil must not be before effectiveFrom',
  });
export const archiveSchema = z.object({ version: z.number().int().min(1) });
export const searchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  audience: z.enum(['GUEST', 'STAFF']).default('STAFF'),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

/**
 * Knowledge administration (`knowledge.manage`) and staff search (`knowledge.read`). Documents of a property are
 * managed at the property; tenant-wide documents need tenant-wide permission. Publishing is immutable: a change is a
 * new version, which supersedes the published one in the same language.
 */
@Injectable()
export class KnowledgeAdminService {
  constructor(
    private readonly repo: KnowledgeRepositories,
    private readonly indexer: KnowledgeIndexer,
    private readonly retriever: KnowledgeRetriever,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  createDocument(scope: PropertyScope, input: z.infer<typeof createDocumentSchema>) {
    return this.manage(scope, input.tenantWide ? null : scope.propertyId, () =>
      this.tx.run(async () => {
        const doc = await this.repo.insertDocument({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: input.tenantWide ? null : scope.propertyId,
          kind: input.kind,
          title: input.title,
        });
        await this.audit.record({
          action: 'knowledge.document.create',
          entityType: 'knowledge_document',
          entityId: doc.id,
          tenantId: scope.tenantId,
          propertyId: doc.propertyId,
          after: { kind: doc.kind, title: doc.title, tenant_wide: doc.propertyId === null },
        });
        return doc;
      }),
    );
  }

  list(scope: PropertyScope) {
    return this.read(scope, async () => {
      const docs = await this.repo.documentsVisibleAt(scope);
      const versions = await this.repo.versionsOf(
        scope,
        docs.map((d) => d.id),
      );
      return docs.map((d) => ({
        ...d,
        tenantWide: d.propertyId === null,
        versions: versions.filter((v) => v.documentId === d.id),
      }));
    });
  }

  async addVersion(
    scope: PropertyScope,
    documentId: string,
    input: z.infer<typeof createVersionSchema>,
  ) {
    const doc = await this.visible(scope, documentId);
    return this.manage(scope, doc.propertyId, () =>
      this.tx.run(async () => {
        if (doc.status !== 'ACTIVE') throw AppError.conflict('knowledge.document.archived');
        const version = await this.repo.insertVersion({
          id: newId(),
          tenantId: scope.tenantId,
          documentId: doc.id,
          versionNo: await this.repo.nextVersionNo(scope, doc.id),
          language: input.language,
          audience: input.audience,
          classification: input.classification,
          departmentCode: input.departmentCode ?? null,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveUntil: input.effectiveUntil ?? null,
          body: input.body,
        });
        const { body: _body, ...summary } = version;
        return summary;
      }),
    );
  }

  async version(scope: PropertyScope, documentId: string, versionId: string) {
    const doc = await this.visible(scope, documentId);
    return this.read(scope, async () => {
      const v = isUuid(versionId) ? await this.repo.version(scope, versionId) : undefined;
      if (!v || v.documentId !== doc.id) throw AppError.notFound('knowledge.version.not_found');
      return v;
    });
  }

  /** Publishes a draft: chunks it in the same transaction, then embeds the chunks (best effort). */
  async publish(scope: PropertyScope, documentId: string, versionId: string) {
    const doc = await this.visible(scope, documentId);
    const published = await this.manage(scope, doc.propertyId, () =>
      this.tx.run(async () => {
        if (doc.status !== 'ACTIVE') throw AppError.conflict('knowledge.document.archived');
        const v = isUuid(versionId)
          ? await this.repo.versionForUpdate(scope, versionId)
          : undefined;
        if (!v || v.documentId !== doc.id) throw AppError.notFound('knowledge.version.not_found');
        if (v.status !== 'DRAFT') throw AppError.conflict('knowledge.version.not_draft');
        const row = await this.repo.publish(scope, v, new Date());
        const chunks = await this.indexer.chunk(row);
        await this.audit.record({
          action: 'knowledge.version.publish',
          entityType: 'knowledge_document_version',
          entityId: row.id,
          tenantId: scope.tenantId,
          propertyId: doc.propertyId,
          after: {
            document_id: doc.id,
            version_no: row.versionNo,
            language: row.language,
            audience: row.audience,
            classification: row.classification,
            chunks,
          },
        });
        return { row, chunks };
      }),
    );
    const embedded = await this.indexer.embedPending(
      { tenantId: scope.tenantId },
      { versionId: published.row.id },
    );
    const { body: _body, ...summary } = published.row;
    return { ...summary, chunks: published.chunks, embedded };
  }

  async archive(scope: PropertyScope, documentId: string, input: z.infer<typeof archiveSchema>) {
    const doc = await this.visible(scope, documentId);
    return this.manage(scope, doc.propertyId, () =>
      this.tx.run(async () => {
        const current = await this.repo.documentForUpdate(scope, doc.id);
        if (!current) throw AppError.notFound('knowledge.document.not_found');
        if (current.version !== input.version)
          throw new AppError('knowledge.document.version_conflict', HttpStatus.CONFLICT);
        const updated = await this.repo.updateDocument(scope, doc.id, { status: 'ARCHIVED' });
        await this.audit.record({
          action: 'knowledge.document.archive',
          entityType: 'knowledge_document',
          entityId: doc.id,
          tenantId: scope.tenantId,
          propertyId: doc.propertyId,
          before: { status: current.status },
          after: { status: updated.status },
        });
        return updated;
      }),
    );
  }

  /** Staff search (and a way to check what the concierge would find for guests). */
  search(scope: PropertyScope, input: z.infer<typeof searchSchema>) {
    return this.gate.execute(
      { action: 'knowledge.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.retriever.search({
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          query: input.query,
          audience: input.audience,
          // What guests may see is only public; staff may see internal and confidential documents.
          maxClassification: input.audience === 'GUEST' ? 'PUBLIC' : 'CONFIDENTIAL',
          language: input.language ?? null,
          limit: input.limit,
        }),
    );
  }

  /** A document of this property or of the whole tenant; anything else is not found (rule 1). */
  private async visible(scope: PropertyScope, id: string): Promise<DocumentRow> {
    const doc = await this.read(scope, async () =>
      isUuid(id) ? await this.repo.document(scope, id) : undefined,
    );
    if (!doc || (doc.propertyId !== null && doc.propertyId !== scope.propertyId))
      throw AppError.notFound('knowledge.document.not_found');
    return doc;
  }

  private manage<T>(scope: PropertyScope, propertyId: string | null, fn: () => Promise<T>) {
    return this.gate.execute(
      { action: 'knowledge.manage', tenantId: scope.tenantId, propertyId },
      fn,
    );
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>) {
    return this.gate.execute(
      { action: 'knowledge.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}
