import { Module } from '@nestjs/common';
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
    I18nModule.forRoot(),
    SecretsModule.forRoot(),
    DatabaseModule.forRoot(),
    QueueModule.forRoot(),
    HttpConventionsModule.forRoot(),
    EventsModule.forRoot(),
    FeatureFlagsModule,
    ManifestModule.forRoot(),
    StorageModule.forRoot(),
    // Phase 1.2 wires the identity context's strategy and resolver; until then nobody is authenticated.
    AuthModule.forRoot(),
    OrganizationModule,
    HealthModule,
    MetaModule,
  ],
})
export class AppModule {}
