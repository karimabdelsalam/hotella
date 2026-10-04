import { Global, Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { WebhookDispatcher } from './application/webhook-delivery';
import { WebhookKeys, WebhookService } from './application/webhook.service';
import { WEBHOOK_EVENTS } from './domain/webhooks';
import { WebhookRepositories } from './infrastructure/webhook-repositories';
import { CONNECTOR_CAPABILITY_STAGE } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import {
  IntegrationInstancesController,
  IntegrationQueueController,
  WebhooksController,
} from './api/controllers';
import {
  ConnectorCatalogService,
  ExceptionService,
  InstanceService,
  MappingService,
} from './application/admin.services';
import { ConnectorCapabilityStage } from './application/capability-stage';
import { HealthService } from './application/health.service';
import { IngestService } from './application/ingest.service';
import { ReconciliationService } from './application/reconciliation.service';
import { ReplayService } from './application/replay.service';
import { ConnectorRegistry } from './connectors/registry';
import { AgentKeys } from './link/agent-keys';
import { EnrollmentService } from './link/enrollment.service';
import { AgentGatewayServer } from './link/gateway-server';
import { AgentLinkService } from './link/link.service';
import { LinkRepositories } from './infrastructure/link-repositories';
import { ReconciliationRepositories } from './infrastructure/reconciliation-repositories';
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
    ReconciliationRepositories,
    WebhookRepositories,
    WebhookKeys,
    IntegrationsPublicApiService,
    { provide: INTEGRATIONS_API, useExisting: IntegrationsPublicApiService },
  ],
  exports: [
    INTEGRATIONS_API,
    ConnectorRegistry,
    IntegrationRepositories,
    LinkRepositories,
    ReconciliationRepositories,
    WebhookRepositories,
    WebhookKeys,
  ],
})
export class IntegrationsCoreModule {}

/** The full Integration Platform for the API: administration, ingestion, catalog sync, manifest. */
@Module({
  imports: [IntegrationsCoreModule],
  controllers: [IntegrationInstancesController, IntegrationQueueController, WebhooksController],
  providers: [
    ConnectorCatalogService,
    InstanceService,
    MappingService,
    ExceptionService,
    HealthService,
    IngestService,
    ReplayService,
    ReconciliationService,
    AgentKeys,
    EnrollmentService,
    WebhookService,
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

export const WEBHOOK_FANOUT_CONSUMER = 'integration.webhooks';
export const WEBHOOK_SWEEP_JOB = 'integration.webhooks.sweep';
const WEBHOOK_SWEEP_EVERY_MS = 30_000;

/**
 * Worker side of outbound webhooks (BUILD_PLAN 11.5): every offered event becomes deliveries for the subscribed
 * endpoints (through the inbox, so exactly once per event), and the sweep sends what is due every 30 seconds.
 */
@Module({
  imports: [IntegrationsCoreModule],
  providers: [WebhookDispatcher],
  exports: [WebhookDispatcher],
})
export class WebhooksWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly dispatcher: WebhookDispatcher,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    for (const name of WEBHOOK_EVENTS)
      this.consumers.on(name, WEBHOOK_FANOUT_CONSUMER, async (envelope) => {
        await this.dispatcher.enqueue(name, envelope);
      });
    this.consumers.onJob(WEBHOOK_SWEEP_JOB, async () => {
      const n = await this.dispatcher.sweep();
      if (n > 0) this.logger.info({ attempted: n }, 'webhook deliveries attempted');
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('normal').upsertJobScheduler(
      WEBHOOK_SWEEP_JOB,
      { every: WEBHOOK_SWEEP_EVERY_MS },
      {
        name: WEBHOOK_SWEEP_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
  }
}
