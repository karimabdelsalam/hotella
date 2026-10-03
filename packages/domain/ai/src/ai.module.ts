import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { SettingsRegistry } from '@hotella/platform-settings';
import { AiAdminController } from './api/controllers';
import { AiAdminService } from './application/admin.service';
import { ModelGatewayService } from './application/gateway.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { AI_SETTINGS } from './domain/settings';
import { AiRepositories } from './infrastructure/repositories';
import { AI_MANIFEST } from './manifest';
import { MODEL_GATEWAY } from './public';

/** The AI context without HTTP routes (API and worker): repositories, provider adapters and `MODEL_GATEWAY`. */
@Global()
@Module({
  providers: [
    AiRepositories,
    ModelProviderRegistry,
    ModelGatewayService,
    { provide: MODEL_GATEWAY, useExisting: ModelGatewayService },
  ],
  exports: [AiRepositories, ModelProviderRegistry, ModelGatewayService, MODEL_GATEWAY],
})
export class AiCoreModule {}

/** Administration API, settings and manifest, for the API process. */
@Module({
  imports: [AiCoreModule],
  controllers: [AiAdminController],
  providers: [AiAdminService],
})
export class AiModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(AI_MANIFEST);
    this.settings.register(...AI_SETTINGS);
  }
}
