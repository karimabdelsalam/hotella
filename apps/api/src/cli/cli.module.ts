import { Module } from '@nestjs/common';
import { IdentityCoreModule, IdentityModule, identityAuthOptions } from '@hotella/domain-identity';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import { SettingsModule } from '@hotella/platform-settings';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';

/** The slice of the API the operations CLI needs: database, outbox, identity. No HTTP, no queues. */
@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    SecretsModule.forRoot(),
    I18nModule.forRoot(),
    DatabaseModule.forRoot(),
    EventsModule.forRoot(),
    FeatureFlagsModule,
    ManifestModule.forRoot(),
    AuditModule,
    SettingsModule,
    IdentityCoreModule,
    AuthModule.forRoot(identityAuthOptions()),
    OrganizationModule,
    IdentityModule,
  ],
})
export class CliModule {}
