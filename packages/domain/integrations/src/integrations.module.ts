import { Global, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { CONNECTOR_CAPABILITY_STAGE } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { IntegrationInstancesController, IntegrationQueueController } from './api/controllers';
import {
  ConnectorCatalogService,
  ExceptionService,
  InstanceService,
  MappingService,
} from './application/admin.services';
import { ConnectorCapabilityStage } from './application/capability-stage';
import { IngestService } from './application/ingest.service';
import { ConnectorRegistry } from './connectors/registry';
import { IntegrationRepositories } from './infrastructure/repositories';
import { INTEGRATIONS_MANIFEST } from './manifest';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from './public';
import { IntegrationsPublicApiService } from './public-api.service';

/** Global so other contexts can inject INTEGRATIONS_API (its only cross-context export) without importing this module. */
@Global()
@Module({
  controllers: [IntegrationInstancesController, IntegrationQueueController],
  providers: [
    { provide: ConnectorRegistry, useValue: new ConnectorRegistry() },
    IntegrationRepositories,
    ConnectorCatalogService,
    InstanceService,
    MappingService,
    ExceptionService,
    IngestService,
    IntegrationsPublicApiService,
    { provide: INTEGRATIONS_API, useExisting: IntegrationsPublicApiService },
  ],
  exports: [INTEGRATIONS_API],
})
export class IntegrationsModule implements OnModuleInit {
  /** `AuthModule.forRoot({ stages: [IntegrationsModule.capabilityStage()] })` — action-gate stage 5 (Spec §60). */
  static capabilityStage(): Provider {
    return {
      provide: CONNECTOR_CAPABILITY_STAGE,
      inject: [INTEGRATIONS_API],
      useFactory: (api: IntegrationsPublicApi) => new ConnectorCapabilityStage(api),
    };
  }

  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(INTEGRATIONS_MANIFEST);
  }
}
