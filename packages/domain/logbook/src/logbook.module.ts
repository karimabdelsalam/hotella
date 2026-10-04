import { Global, Module, type OnModuleInit, Optional, Inject } from '@nestjs/common';
import { AI_TOOL_REGISTRY, type AiToolRegistrar } from '@hotella/domain-ai/public';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { SettingsRegistry } from '@hotella/platform-settings';
import { LogbookController } from './api/controllers';
import { LogbookAiTools } from './application/ai-tools';
import { FactsService } from './application/facts.service';
import { LogbookService } from './application/logbook.service';
import { LOGBOOK_SETTINGS } from './domain/settings';
import { LogbookRepositories } from './infrastructure/repositories';
import { LOGBOOK_MANIFEST } from './manifest';

/**
 * The logbook without HTTP routes (API and worker): repositories, facts, entries and handovers. Registers the
 * SHIFT_HANDOVER assistant's READ tool when the AI tools are composed.
 */
@Global()
@Module({
  providers: [LogbookRepositories, FactsService, LogbookService, LogbookAiTools],
  exports: [LogbookRepositories, FactsService, LogbookService],
})
export class LogbookCoreModule implements OnModuleInit {
  constructor(
    private readonly aiTools: LogbookAiTools,
    @Optional() @Inject(AI_TOOL_REGISTRY) private readonly tools?: AiToolRegistrar,
  ) {}
  onModuleInit(): void {
    if (this.tools) this.aiTools.registerInto(this.tools);
  }
}

/** Staff API, settings and manifest, for the API process. */
@Module({ imports: [LogbookCoreModule], controllers: [LogbookController] })
export class LogbookModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(LOGBOOK_MANIFEST);
    this.settings.register(...LOGBOOK_SETTINGS);
  }
}
