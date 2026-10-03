import { Module } from '@nestjs/common';
import {
  IdentityCoreModule,
  IdentityModule,
  identityAuthOptions,
  identityLocalePreferences,
} from '@hotella/domain-identity';
import { OrganizationModule } from '@hotella/domain-organization';
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
    StorageModule.forRoot(),
    // Staff identity (ADR-0011): JWT access tokens + live-session check, Membership → Role → Permission resolution.
    IdentityCoreModule,
    AuthModule.forRoot({
      ...identityAuthOptions(),
      propertyVerifier: OrganizationModule.propertyVerifier(),
    }),
    OrganizationModule,
    IdentityModule,
    HealthModule,
    MetaModule,
  ],
})
export class AppModule {}
