import { Inject, Injectable } from '@nestjs/common';
import { MODEL_GATEWAY, type ModelGatewayApi } from '@hotella/domain-ai/public';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { chunkText, normalizeForSearch } from '../domain/text';
import { KnowledgeRepositories } from '../infrastructure/repositories';
import type { DocumentVersionRow } from '../infrastructure/schema';

const BATCH = 32;

/**
 * Turns a published version into retrievable chunks (keyword index at once) and embeds them through the Model Gateway
 * with the version's classification as data class (ADR-0018). Embedding is best effort: without an embedding route
 * the chunks stay keyword-searchable and the worker sweep embeds them later.
 */
@Injectable()
export class KnowledgeIndexer {
  constructor(
    private readonly repo: KnowledgeRepositories,
    private readonly tx: TransactionRunner,
    @Inject(MODEL_GATEWAY) private readonly gateway: ModelGatewayApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Inside the publishing transaction. */
  async chunk(version: DocumentVersionRow): Promise<number> {
    const pieces = chunkText(version.body);
    await this.repo.insertChunks(
      pieces.map((text, seq) => ({
        id: newId(),
        tenantId: version.tenantId,
        versionId: version.id,
        seq,
        text,
        normalized: normalizeForSearch(text),
      })),
    );
    return pieces.length;
  }

  /** Embeds chunks still without an embedding (of one version, or of every tenant for the sweep); returns how many. */
  async embedPending(
    scope: { tenantId: string } | null,
    opts: { versionId?: string; max?: number } = {},
  ): Promise<number> {
    let done = 0;
    const max = opts.max ?? 500;
    while (done < max) {
      const pending = await this.tx.read(() =>
        this.repo.chunksToEmbed(scope, Math.min(BATCH, max - done), opts.versionId),
      );
      if (pending.length === 0) break;
      // One gateway call per tenant/property/class group: the egress policy applies per call.
      const groups = new Map<string, typeof pending>();
      for (const c of pending) {
        const key = `${c.tenantId}|${c.propertyId ?? ''}|${c.classification}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      for (const group of groups.values()) {
        const first = group[0]!;
        let result: { vectors: readonly (readonly number[])[]; model: string };
        try {
          result = await this.gateway.embed({
            tenantId: first.tenantId,
            propertyId: first.propertyId,
            texts: group.map((c) => ({ text: c.text, dataClass: c.classification })),
          });
        } catch (e) {
          this.logger.info(
            { tenant_id: first.tenantId, chunks: group.length, reason: (e as Error).message },
            'knowledge chunks left for a later embedding',
          );
          return done;
        }
        await this.tx.run(() =>
          this.repo.insertEmbeddings(
            group.map((c, i) => ({
              chunkId: c.id,
              tenantId: c.tenantId,
              modelCode: result.model,
              dims: result.vectors[i]!.length,
              embedding: [...result.vectors[i]!],
            })),
          ),
        );
        done += group.length;
      }
    }
    return done;
  }
}
