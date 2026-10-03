import { Module } from '@nestjs/common';
import { GuestEventsModule } from '@hotella/domain-guest';
import { IntegrationsCoreModule } from '@hotella/domain-integrations';
import { IdentityDirectoryModule } from '@hotella/domain-identity';
import { OperationsWorkerModule } from '@hotella/domain-operations';
import { OrganizationCoreModule } from '@hotella/domain-organization';
import { AuditCoreModule } from '@hotella/platform-audit';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { EVENT_TRANSPORT, EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { BULLMQ_EVENT_TRANSPORT, QueueModule } from '@hotella/platform-queue';
import { SecretsModule } from '@hotella/platform-secrets';
import { WorkerRuntimeModule } from './runtime/runtime.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    SecretsModule.forRoot(),
    DatabaseModule.forRoot(),
    QueueModule.forRoot(),
    // The worker is where the relay runs, so the outbox publishes through BullMQ.
    EventsModule.forRoot({
      transport: { provide: EVENT_TRANSPORT, useExisting: BULLMQ_EVENT_TRANSPORT },
    }),
    FeatureFlagsModule,
    ManifestModule.forRoot(),
    // Context consumers (no HTTP routes): the stay projection of canonical PMS events.
    AuditCoreModule,
    IntegrationsCoreModule,
    GuestEventsModule,
    // The operations engine for background work (SLA sweep, approval expiry), with route-free lookups of the
    // contexts it validates against.
    OrganizationCoreModule,
    IdentityDirectoryModule,
    OperationsWorkerModule,
    WorkerRuntimeModule,
  ],
})
export class WorkerAppModule {}
