import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { AlertsController, OperationsController, SlaAdminController } from './api/controllers';
import { AlertAdminService, AlertService } from './application/alert.service';
import { OperationsQueryService } from './application/queries';
import { SlaAdminService } from './application/sla-admin.service';
import { SlaMonitor, SlaService } from './application/sla.service';
import { TaskService } from './application/task.service';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import { OperationsRepositories } from './infrastructure/repositories';
import { SlaRepositories } from './infrastructure/sla-repositories';
import { OPERATIONS_MANIFEST } from './manifest';
import { OPERATIONS_API } from './public';
import { OperationsPublicApiService } from './public-api.service';

/** Repeatable job of the worker that fires SLA breaches and escalations. */
export const SLA_SWEEP_JOB = 'ops.sla.sweep';
const SLA_SWEEP_EVERY_MS = 15_000;

/**
 * The engine without HTTP routes: repositories, the kind registry, SLA and OPERATIONS_API. Global so every module can
 * inject OPERATIONS_API and register its work-item kinds.
 */
@Global()
@Module({
  providers: [
    OperationsRepositories,
    SlaRepositories,
    WorkItemKindRegistry,
    AlertService,
    SlaService,
    WorkService,
    OperationsPublicApiService,
    { provide: OPERATIONS_API, useExisting: OperationsPublicApiService },
  ],
  exports: [
    OPERATIONS_API,
    WorkService,
    WorkItemKindRegistry,
    OperationsRepositories,
    SlaRepositories,
    AlertService,
    SlaService,
  ],
})
export class OperationsCoreModule {}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [OperationsCoreModule],
  controllers: [OperationsController, SlaAdminController, AlertsController],
  providers: [OperationsQueryService, TaskService, SlaAdminService, AlertAdminService],
})
export class OperationsModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(OPERATIONS_MANIFEST);
  }
}

/**
 * Worker side: the SLA sweep on the `critical-operational` queue (every 15 s; deadlines are minute-based). It needs no
 * other context, so the worker does not load organization, identity or guest.
 */
@Module({ providers: [SlaRepositories, AlertService, SlaMonitor], exports: [SlaMonitor] })
export class OperationsWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueRegistry,
    private readonly consumers: EventConsumerRegistry,
    private readonly monitor: SlaMonitor,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumers.onJob(SLA_SWEEP_JOB, async () => {
      await this.monitor.sweep();
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('critical-operational').upsertJobScheduler(
      SLA_SWEEP_JOB,
      { every: SLA_SWEEP_EVERY_MS },
      {
        name: SLA_SWEEP_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
    this.logger.info({ job: SLA_SWEEP_JOB, every_ms: SLA_SWEEP_EVERY_MS }, 'sla sweep armed');
  }
}
