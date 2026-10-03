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
import { HealthService } from './application/health.service';
import { IngestService } from './application/ingest.service';
import { ReplayService } from './application/replay.service';
import { ConnectorRegistry } from './connectors/registry';
import { AgentKeys } from './link/agent-keys';
import { EnrollmentService } from './link/enrollment.service';
import { AgentGatewayServer } from './link/gateway-server';
import { AgentLinkService } from './link/link.service';
import { LinkRepositories } from './infrastructure/link-repositories';
import { IntegrationRepositories } from './infrastructure/repositories';
import { INTEGRATIONS_MANIFEST } from './manifest';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from './public';
import { IntegrationsPublicApiService } from './public-api.service';

/**
 * The cross-context surface without HTTP routes or ingestion: INTEGRATIONS_API (external references, capabilities).
 * Global so other contexts inject the token without importing this module; background processes import only this.
 */
@Global()
@Module({
  providers: [
    { provide: ConnectorRegistry, useValue: new ConnectorRegistry() },
    IntegrationRepositories,
    LinkRepositories,
    IntegrationsPublicApiService,
    { provide: INTEGRATIONS_API, useExisting: IntegrationsPublicApiService },
  ],
  exports: [INTEGRATIONS_API, ConnectorRegistry, IntegrationRepositories, LinkRepositories],
})
export class IntegrationsCoreModule {}

/** The full Integration Platform for the API: administration, ingestion, catalog sync, manifest. */
@Module({
  imports: [IntegrationsCoreModule],
  controllers: [IntegrationInstancesController, IntegrationQueueController],
  providers: [
    ConnectorCatalogService,
    InstanceService,
    MappingService,
    ExceptionService,
    HealthService,
    IngestService,
    ReplayService,
    AgentKeys,
    EnrollmentService,
  ],
  exports: [IngestService, HealthService, AgentKeys, EnrollmentService],
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

/**
 * The hotel-agent gateway (ADR-0017) for the `agent-gateway` process: link protocol and the TLS/mTLS server. Its
 * HTTP surface is the gateway server itself; it registers no Nest controllers.
 */
@Module({
  imports: [IntegrationsModule],
  providers: [AgentLinkService, AgentGatewayServer],
  exports: [AgentLinkService, AgentGatewayServer],
})
export class AgentGatewayModule {}
