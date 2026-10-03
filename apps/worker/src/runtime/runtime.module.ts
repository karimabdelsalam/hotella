import { Module } from '@nestjs/common';
import { WorkerHealthController } from './health.controller';
import { PingConsumer } from './ping.consumer';
import { QueueWorkersService } from './queue-workers.service';
import { RelayService } from './relay.service';
import { SchedulerService } from './scheduler.service';

@Module({
  controllers: [WorkerHealthController],
  providers: [RelayService, QueueWorkersService, SchedulerService, PingConsumer],
  exports: [PingConsumer, RelayService],
})
export class WorkerRuntimeModule {}
