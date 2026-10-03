import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { LostFoundItemRegistered } from '@hotella/contracts-events';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import { LostFoundController } from './api/controllers';
import { AttributesService } from './application/attributes.service';
import { ItemService } from './application/item.service';
import { LostFoundPublicApiService } from './application/public-api.service';
import { LOSTFOUND_SETTINGS } from './domain/settings';
import { LostFoundRepositories } from './infrastructure/repositories';
import { LOSTFOUND_MANIFEST } from './manifest';
import { LOSTFOUND_API } from './public';

/** Inbox consumer of the worker and the job it queues on `background-ai`. */
export const LOSTFOUND_ATTRIBUTES_CONSUMER = 'lostfound.attributes';
export const LOSTFOUND_ATTRIBUTES_JOB = 'lostfound.attributes.derive';

/** Lost & Found without HTTP routes (API and worker): repositories, items and `LOSTFOUND_API`. */
@Global()
@Module({
  providers: [
    LostFoundRepositories,
    ItemService,
    LostFoundPublicApiService,
    { provide: LOSTFOUND_API, useExisting: LostFoundPublicApiService },
  ],
  exports: [LostFoundRepositories, ItemService, LOSTFOUND_API],
})
export class LostFoundCoreModule {}

/** Staff API, settings and manifest, for the API process. */
@Module({
  imports: [LostFoundCoreModule],
  controllers: [LostFoundController],
})
export class LostFoundModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(LOSTFOUND_MANIFEST);
    this.settings.register(...LOSTFOUND_SETTINGS);
  }
}

/**
 * Worker side (needs `MODEL_GATEWAY`, i.e. the AI core): a newly registered item gets AI-derived attributes on
 * `background-ai`, then matching runs again with them.
 */
@Module({ imports: [LostFoundCoreModule], providers: [AttributesService] })
export class LostFoundWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly attributes: AttributesService,
  ) {}
  onModuleInit(): void {
    this.consumers.on(
      LostFoundItemRegistered.name,
      LOSTFOUND_ATTRIBUTES_CONSUMER,
      async (envelope) => {
        if (!envelope.tenant_id) return;
        const e = LostFoundItemRegistered.parse(envelope);
        await this.queues.enqueue(
          'background-ai',
          LOSTFOUND_ATTRIBUTES_JOB,
          { tenantId: envelope.tenant_id, itemId: e.payload.item_id },
          { jobId: `lostfound-attributes-${e.payload.item_id}` },
        );
      },
    );
    this.consumers.onJob<{ tenantId: string; itemId: string }>(
      LOSTFOUND_ATTRIBUTES_JOB,
      async (data) => {
        await this.attributes.derive(data.tenantId, data.itemId);
      },
    );
  }
}
