import { Inject, Injectable } from '@nestjs/common';
import { MODEL_GATEWAY, type ModelGatewayApi } from '@hotella/domain-ai/public';
import { isUuid, TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { fuseRanks, normalizeForSearch } from '../domain/text';
import { type CandidateFilter, KnowledgeRepositories } from '../infrastructure/repositories';
import type {
  KnowledgeClassification,
  KnowledgeDocumentSummary,
  KnowledgePassage,
  KnowledgePublicApi,
  KnowledgeSearchInput,
} from '../public';

const CLASSES: readonly KnowledgeClassification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'];
const CANDIDATES = 20;
/** Cosine distance beyond which a vector neighbour is not a match (similarity below 0.5). */
const MAX_VECTOR_DISTANCE = 0.5;

/**
 * Hybrid retrieval (BUILD_PLAN 6.D, Spec §37): scoped candidates, normalized keyword ranking and vector ranking fused by
 * reciprocal rank — deterministic, no model call besides embedding the query. The preferred language is searched first,
 * every language when it has nothing. Passages name the exact document version (Spec §38).
 */
@Injectable()
export class KnowledgeRetriever implements KnowledgePublicApi {
  constructor(
    private readonly repo: KnowledgeRepositories,
    private readonly tx: TransactionRunner,
    @Inject(MODEL_GATEWAY) private readonly gateway: ModelGatewayApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  getDocument(tenantId: string, documentId: string): Promise<KnowledgeDocumentSummary | null> {
    return this.tx.read(async () => {
      const d = isUuid(documentId) ? await this.repo.document({ tenantId }, documentId) : undefined;
      return d
        ? { id: d.id, propertyId: d.propertyId, kind: d.kind, title: d.title, status: d.status }
        : null;
    });
  }

  async search(input: KnowledgeSearchInput): Promise<readonly KnowledgePassage[]> {
    const normalized = normalizeForSearch(input.query);
    const terms = [...new Set(normalized.split(' ').filter((t) => t.length >= 2))].slice(0, 24);
    const queryVector = await this.embedQuery(input);
    const base: Omit<CandidateFilter, 'language'> = {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      audience: input.audience,
      classifications: CLASSES.slice(0, CLASSES.indexOf(input.maxClassification) + 1),
      today: new Date().toISOString().slice(0, 10),
      departmentCode: input.departmentCode ?? null,
      documentIds: input.documentIds ? input.documentIds.filter(isUuid) : null,
    };
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
    return this.tx.read(async () => {
      let found = await this.rank(
        { ...base, language: input.language ?? null },
        terms,
        queryVector,
        limit,
      );
      if (found.length === 0 && input.language)
        found = await this.rank({ ...base, language: null }, terms, queryVector, limit);
      return found;
    });
  }

  private async rank(
    filter: CandidateFilter,
    terms: readonly string[],
    queryVector: { vector: readonly number[]; model: string } | null,
    limit: number,
  ): Promise<KnowledgePassage[]> {
    const keyword = await this.repo.keyword(filter, terms, CANDIDATES);
    const vector = queryVector
      ? await this.repo.nearest(
          filter,
          queryVector.vector,
          queryVector.model,
          CANDIDATES,
          MAX_VECTOR_DISTANCE,
        )
      : [];
    const scores = fuseRanks([keyword, vector]);
    const top = [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit);
    const rows = new Map(
      (
        await this.repo.passages(
          { tenantId: filter.tenantId },
          top.map(([id]) => id),
        )
      ).map((r) => [r.chunkId, r]),
    );
    return top.flatMap(([id, score]) => {
      const r = rows.get(id);
      if (!r) return [];
      return [
        {
          ...r,
          score: Math.round(score * 1e6) / 1e6,
          matchedBy: [
            ...(keyword.includes(id) ? (['KEYWORD'] as const) : []),
            ...(vector.includes(id) ? (['VECTOR'] as const) : []),
          ],
        },
      ];
    });
  }

  /** The query's embedding, or null when no embedding route is available (keyword search still works). */
  private async embedQuery(
    input: KnowledgeSearchInput,
  ): Promise<{ vector: readonly number[]; model: string } | null> {
    try {
      const result = await this.gateway.embed({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        // The query may quote a guest.
        texts: [{ text: input.query, dataClass: 'CONFIDENTIAL' }],
      });
      const vector = result.vectors[0];
      return vector ? { vector, model: result.model } : null;
    } catch (e) {
      this.logger.debug({ reason: (e as Error).message }, 'knowledge search without vectors');
      return null;
    }
  }
}
