import { Global, Inject, Module, type OnModuleInit, Optional } from '@nestjs/common';
import { AI_TOOL_REGISTRY, type AiToolRegistrar } from '@hotella/domain-ai/public';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { KnowledgeController } from './api/controllers';
import { KnowledgeAdminService } from './application/admin.service';
import { KnowledgeIndexer } from './application/indexer';
import { KnowledgeRetriever } from './application/retriever';
import { knowledgeSearchTool } from './application/search-tool';
import { KnowledgeRepositories } from './infrastructure/repositories';
import { KNOWLEDGE_MANIFEST } from './manifest';
import { KNOWLEDGE_API } from './public';

/** Embeds chunks published while no embedding route existed (worker, every 5 minutes). */
export const KNOWLEDGE_EMBED_SWEEP_JOB = 'knowledge.embed.sweep';
const EMBED_SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Knowledge without HTTP routes (API and worker): repositories, indexer, `KNOWLEDGE_API`, and the `knowledge.search`
 * tool registered into the AI tool registry when the AI tools are composed.
 */
@Global()
@Module({
  providers: [
    KnowledgeRepositories,
    KnowledgeIndexer,
    KnowledgeRetriever,
    { provide: KNOWLEDGE_API, useExisting: KnowledgeRetriever },
  ],
  exports: [KnowledgeRepositories, KnowledgeIndexer, KnowledgeRetriever, KNOWLEDGE_API],
})
export class KnowledgeCoreModule implements OnModuleInit {
  constructor(
    private readonly retriever: KnowledgeRetriever,
    @Optional() @Inject(AI_TOOL_REGISTRY) private readonly tools?: AiToolRegistrar,
  ) {}
  onModuleInit(): void {
    this.tools?.register(knowledgeSearchTool(this.retriever));
  }
}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [KnowledgeCoreModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeAdminService],
})
export class KnowledgeModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(KNOWLEDGE_MANIFEST);
  }
}

/** Worker side: the embedding sweep. */
@Module({ imports: [KnowledgeCoreModule] })
export class KnowledgeWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly indexer: KnowledgeIndexer,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    this.consumers.onJob(KNOWLEDGE_EMBED_SWEEP_JOB, async () => {
      const n = await this.indexer.embedPending(null);
      if (n > 0) this.logger.info({ embedded: n }, 'knowledge chunks embedded');
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('background-ai').upsertJobScheduler(
      KNOWLEDGE_EMBED_SWEEP_JOB,
      { every: EMBED_SWEEP_EVERY_MS },
      {
        name: KNOWLEDGE_EMBED_SWEEP_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
  }
}
