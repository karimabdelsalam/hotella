import { Global, Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { EntitlementsChanged } from '@hotella/contracts-events';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { WebhookDispatcher } from './application/webhook-delivery';
import { WebhookKeys, WebhookService } from './application/webhook.service';
import { InboundEndpointService } from './application/inbound.service';
import { WEBHOOK_EVENTS } from './domain/webhooks';
import { WebhookRepositories } from './infrastructure/webhook-repositories';
import { CONNECTOR_CAPABILITY_STAGE } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import {
  IntegrationInstancesController,
  IntegrationQueueController,
  PropertyCapabilitiesController,
  CommissioningController,
  InboundEndpointsController,
  InboundIngressController,
  WebhooksController,
} from './api/controllers';
import { CapabilityAdminService } from './application/capability-admin.service';
import { CommissioningService } from './application/commissioning.service';
import { CommissioningRepositories } from './infrastructure/commissioning-repositories';
import { CapabilityRegistry } from './application/capability-registry';
import { PmsService } from './application/pms.service';
import { CapabilityRepositories } from './infrastructure/capability-repositories';
import { ProfileRepositories } from './infrastructure/profile-repositories';
import { QueryRepositories } from './infrastructure/query-repositories';
import { AgentQueryService } from './application/agent-query.service';
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
import { INTEGRATIONS_API, type IntegrationsPublicApi, PMS_API } from './public';
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
    CapabilityRepositories,
    CapabilityRegistry,
    QueryRepositories,
    ProfileRepositories,
    AgentQueryService,
    IntegrationsPublicApiService,
    { provide: INTEGRATIONS_API, useExisting: IntegrationsPublicApiService },
    PmsService,
    { provide: PMS_API, useExisting: PmsService },
  ],
  exports: [
    INTEGRATIONS_API,
    PMS_API,
    CapabilityRepositories,
    CapabilityRegistry,
    QueryRepositories,
    ProfileRepositories,
    AgentQueryService,
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
  controllers: [
    IntegrationInstancesController,
    IntegrationQueueController,
    PropertyCapabilitiesController,
    CommissioningController,
    WebhooksController,
    InboundEndpointsController,
    InboundIngressController,
  ],
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
    InboundEndpointService,
    CapabilityAdminService,
    CommissioningService,
    CommissioningRepositories,
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

export const CAPABILITY_LICENCE_CONSUMER = 'integration.capabilities-licence';
export const QUERY_SWEEP_JOB = 'integration.queries.sweep';
/** Answers wait at most this long for their asker; requests past their deadline are closed. */
const QUERY_RESULT_KEEP_MS = 2 * 60_000;

/**
 * Worker side of the Integration Platform. Outbound webhooks (BUILD_PLAN 11.5): every offered event becomes deliveries
 * for the subscribed endpoints (through the inbox, so exactly once per event), and the sweep sends what is due every
 * 30 seconds. Capability registry (10.6): a licence change re-evaluates the tenant's properties.
 */
@Module({
  imports: [IntegrationsCoreModule],
  providers: [WebhookDispatcher],
  exports: [WebhookDispatcher],
})
export class IntegrationsWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly dispatcher: WebhookDispatcher,
    private readonly capabilities: CapabilityRegistry,
    private readonly tx: TransactionRunner,
    private readonly queries: QueryRepositories,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    this.consumers.onJob(QUERY_SWEEP_JOB, async () => {
      const n = await this.tx.run(() => this.queries.sweep(new Date(), QUERY_RESULT_KEEP_MS));
      if (n.cleared + n.expired > 0) this.logger.info(n, 'agent query answers cleared');
    });
    this.consumers.on(EntitlementsChanged.name, CAPABILITY_LICENCE_CONSUMER, async (envelope) => {
      if (!envelope.tenant_id) return;
      const e = EntitlementsChanged.parse(envelope);
      const tenantId = envelope.tenant_id;
      await this.tx.run(() => this.capabilities.refreshTenant({ tenantId }, e.payload.property_id));
    });
    for (const name of WEBHOOK_EVENTS)
      this.consumers.on(name, WEBHOOK_FANOUT_CONSUMER, async (envelope) => {
        await this.dispatcher.enqueue(name, envelope);
      });
    this.consumers.onJob(WEBHOOK_SWEEP_JOB, async () => {
      const n = await this.dispatcher.sweep();
      if (n > 0) this.logger.info({ attempted: n }, 'webhook deliveries attempted');
    });
    if (!this.config.worker.schedulerEnabled) return;
    for (const [job, every] of [
      [WEBHOOK_SWEEP_JOB, WEBHOOK_SWEEP_EVERY_MS],
      [QUERY_SWEEP_JOB, 60_000],
    ] as const)
      await this.queues.queue('normal').upsertJobScheduler(
        job,
        { every },
        {
          name: job,
          data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
          opts: { removeOnComplete: 10, removeOnFail: 50 },
        },
      );
  }
}
