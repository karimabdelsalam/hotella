import { type DynamicModule, Module } from '@nestjs/common';
import { GuestEventsModule } from '@hotella/domain-guest';
import { IntegrationsCoreModule, IntegrationsModule } from '@hotella/domain-integrations';
import { IdentityDirectoryModule } from '@hotella/domain-identity';
import { AiModule, AiWorkerModule } from '@hotella/domain-ai';
import { EngineeringWorkerModule } from '@hotella/domain-engineering';
import { InspectionWorkerModule } from '@hotella/domain-inspection';
import { RelationsWorkerModule } from '@hotella/domain-relations';
import { LostFoundWorkerModule } from '@hotella/domain-lostfound';
import { HousekeepingWorkerModule } from '@hotella/domain-housekeeping';
import { KnowledgeWorkerModule } from '@hotella/domain-knowledge';
import { CatalogServicesModule, CatalogWorkerModule } from '@hotella/domain-catalog';
import { CommunicationsWorkerModule } from '@hotella/domain-communications';
import { OperationsWorkerModule } from '@hotella/domain-operations';
import { OrganizationCoreModule } from '@hotella/domain-organization';
import { AuditCoreModule } from '@hotella/platform-audit';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { EVENT_TRANSPORT, EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { BULLMQ_EVENT_TRANSPORT, QueueModule } from '@hotella/platform-queue';
import { SecretsModule } from '@hotella/platform-secrets';
import { SettingsCoreModule } from '@hotella/platform-settings';
import { WorkerRuntimeModule } from './runtime/runtime.module';

/** Everything the worker runs besides its configuration. */
const WORKER_MODULES = [
  ObservabilityModule.forRoot(),
  // Notification templates are rendered per recipient locale (Spec §25, shared ICU catalog).
  I18nModule.forRoot(),
  SecretsModule.forRoot(),
  DatabaseModule.forRoot(),
  QueueModule.forRoot(),
  // The worker is where the relay runs, so the outbox publishes through BullMQ.
  EventsModule.forRoot({
    transport: { provide: EVENT_TRANSPORT, useExisting: BULLMQ_EVENT_TRANSPORT },
  }),
  FeatureFlagsModule,
  ManifestModule.forRoot(),
  // Property policy (grant scopes, post-stay window) is configuration, read without the settings API.
  SettingsCoreModule,
  // Context consumers (no HTTP routes): the stay projection of canonical PMS events.
  AuditCoreModule,
  IntegrationsCoreModule,
  GuestEventsModule,
  // The operations engine for background work (SLA sweep, approval expiry, notifications), with route-free lookups
  // of the contexts it validates against.
  OrganizationCoreModule,
  IdentityDirectoryModule,
  OperationsWorkerModule,
  // Communications follows guest events (anonymization).
  CommunicationsWorkerModule,
  // Service requests follow their work items and the stay (catalog); CATALOG_API for AI tools.
  CatalogWorkerModule,
  CatalogServicesModule,
  // AI tools act through the ActionGate as AI_AGENT (no HTTP guard: the worker's routes are health checks).
  AuthModule.forRoot({
    httpGuard: false,
    stages: [IntegrationsModule.capabilityStage(), ...AiModule.gateStages()],
  }),
  // The Model Gateway and the Guest Concierge runtime on `background-ai` (ADR-0018, BUILD_PLAN 6.3).
  AiWorkerModule,
  // Hotel knowledge for the concierge's knowledge.search tool, and the embedding sweep.
  KnowledgeWorkerModule,
  // The room projection follows the PMS (check-in/out, room moves, room statuses).
  HousekeepingWorkerModule,
  EngineeringWorkerModule,
  InspectionWorkerModule,
  // Recovery whose approval was rejected or expired; the concierge's complaint-candidate tool.
  RelationsWorkerModule,
  // AI-derived attributes of lost and found items on `background-ai`, then matching again.
  LostFoundWorkerModule,
  WorkerRuntimeModule,
];

/** The worker process. `forRoot()` reads the environment through platform-config (main.ts); tests pass `env`. */
@Module({})
export class WorkerAppModule {
  static forRoot(
    options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
  ): DynamicModule {
    return { module: WorkerAppModule, imports: [ConfigModule.forRoot(options), ...WORKER_MODULES] };
  }
}
