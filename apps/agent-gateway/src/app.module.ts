import { Module } from '@nestjs/common';
import { IdentityCoreModule, identityAuthOptions } from '@hotella/domain-identity';
import { AgentGatewayModule, IntegrationsModule } from '@hotella/domain-integrations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';

/**
 * The agent gateway process (ADR-0017). It runs as a Nest *application context*: providers only, no HTTP routes —
 * the only listener is AgentGatewayServer (TLS 1.3, client certificates) with the agent endpoints. Canonical events
 * go to the outbox like everywhere else; the worker relays and projects them.
 */
@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    I18nModule.forRoot(),
    SecretsModule.forRoot(),
    DatabaseModule.forRoot(),
    EventsModule.forRoot(),
    FeatureFlagsModule,
    ManifestModule.forRoot(),
    AuditModule,
    SettingsModule,
    IdentityCoreModule,
    AuthModule.forRoot({
      ...identityAuthOptions(),
      propertyVerifier: OrganizationModule.propertyVerifier(),
      stages: [IntegrationsModule.capabilityStage()],
    }),
    OrganizationModule,
    IntegrationsModule,
    AgentGatewayModule,
  ],
})
export class AgentGatewayAppModule {}
