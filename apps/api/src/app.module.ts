import { Module } from '@nestjs/common';
import {
  IdentityCoreModule,
  IdentityModule,
  identityAuthOptions,
  identityLocalePreferences,
} from '@hotella/domain-identity';
import { AiModule } from '@hotella/domain-ai';
import { EngineeringModule } from '@hotella/domain-engineering';
import { InspectionModule } from '@hotella/domain-inspection';
import { RelationsModule } from '@hotella/domain-relations';
import { LostFoundModule } from '@hotella/domain-lostfound';
import { LogbookModule } from '@hotella/domain-logbook';
import { LicensingModule } from '@hotella/domain-licensing';
import { HousekeepingModule } from '@hotella/domain-housekeeping';
import { KnowledgeModule } from '@hotella/domain-knowledge';
import { CatalogModule } from '@hotella/domain-catalog';
import { CommunicationsModule, CommunicationsRealtimeModule } from '@hotella/domain-communications';
import { GuestModule } from '@hotella/domain-guest';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { OperationsModule } from '@hotella/domain-operations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import { SettingsModule } from '@hotella/platform-settings';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { ManifestModule } from '@hotella/platform-manifest';
import { I18nModule } from '@hotella/platform-i18n';
import { ObservabilityModule } from '@hotella/platform-observability';
import { QueueModule } from '@hotella/platform-queue';
import { SecretsModule } from '@hotella/platform-secrets';
import { StorageModule } from '@hotella/platform-storage';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    I18nModule.forRoot({ preferences: identityLocalePreferences() }),
    SecretsModule.forRoot(),
    DatabaseModule.forRoot(),
    QueueModule.forRoot(),
    HttpConventionsModule.forRoot(),
    EventsModule.forRoot(),
    FeatureFlagsModule,
    ManifestModule.forRoot(),
    AuditModule,
    SettingsModule,
    StorageModule.forRoot(),
    // Staff identity (ADR-0011): JWT access tokens + live-session check, Membership → Role → Permission resolution.
    IdentityCoreModule,
    AuthModule.forRoot({
      ...identityAuthOptions(),
      propertyVerifier: OrganizationModule.propertyVerifier(),
      stages: [IntegrationsModule.capabilityStage(), ...AiModule.gateStages()],
    }),
    OrganizationModule,
    IdentityModule,
    IntegrationsModule,
    GuestModule,
    OperationsModule,
    CommunicationsModule,
    CommunicationsRealtimeModule,
    CatalogModule,
    AiModule,
    KnowledgeModule,
    HousekeepingModule,
    EngineeringModule,
    InspectionModule,
    RelationsModule,
    LostFoundModule,
    LogbookModule,
    LicensingModule,
    HealthModule,
    MetaModule,
  ],
})
export class AppModule {}
