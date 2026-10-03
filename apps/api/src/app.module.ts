import { Module } from '@nestjs/common';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { I18nModule } from '@hotella/platform-i18n';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { StorageModule } from '@hotella/platform-storage';
import { HealthModule } from './health/health.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { MetaModule } from './meta/meta.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    ObservabilityModule.forRoot(),
    I18nModule.forRoot(),
    SecretsModule.forRoot(),
    DatabaseModule.forRoot(),
    StorageModule.forRoot(),
    HealthModule,
    MetaModule,
  ],
  providers: [ProblemDetailsFilter],
})
export class AppModule {}
