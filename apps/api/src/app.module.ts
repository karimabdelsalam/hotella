import { Module } from '@nestjs/common';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { StorageModule } from '@hotella/platform-storage';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    SecretsModule.forRoot(),
    DatabaseModule.forRoot(),
    StorageModule.forRoot(),
    HealthModule,
    MetaModule,
  ],
})
export class AppModule {}
