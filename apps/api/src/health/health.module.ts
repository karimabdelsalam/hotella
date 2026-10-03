import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './postgres.health';
import { ValkeyHealthIndicator } from './valkey.health';

@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  controllers: [HealthController],
  providers: [PostgresHealthIndicator, ValkeyHealthIndicator],
})
export class HealthModule {}
