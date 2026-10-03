import { Module } from '@nestjs/common';
import { ConfigModule } from '@hotella/platform-config';
import { LoggerModule } from '@hotella/platform-observability';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';

@Module({
  imports: [ConfigModule.forRoot(), LoggerModule.forRoot(), HealthModule, MetaModule],
})
export class AppModule {}
