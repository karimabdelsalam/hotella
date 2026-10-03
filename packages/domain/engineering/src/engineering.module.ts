import { Global, Inject, Module, type OnModuleInit, Optional } from '@nestjs/common';
import { AI_TOOL_REGISTRY, type AiToolRegistrar } from '@hotella/domain-ai/public';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import {
  AssetsController,
  EngineeringReferenceController,
  MaintenanceController,
  ProceduresController,
  WorkOrdersController,
} from './api/controllers';
import { MaintenanceService } from './application/maintenance.service';
import { RestrictionService } from './application/restriction.service';
import { EngineeringAiTools } from './application/ai-tools';
import { AssetService } from './application/asset.service';
import { CopilotService } from './application/copilot.service';
import { EngineeringPublicApiService } from './application/public-api.service';
import { ENG_WORK_ORDER_KIND, WorkOrderService } from './application/work-order.service';
import { EngineeringRepositories } from './infrastructure/repositories';
import { ENGINEERING_MANIFEST } from './manifest';
import { ENGINEERING_API } from './public';

/** Inbox consumer of the worker: work orders follow their work items. */
export const WORK_ORDER_CONSUMER = 'eng.work-orders';
/** Hourly job: opens the preventive work of every due plan. */
export const PM_SWEEP_JOB = 'eng.pm.sweep';
const PM_SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Engineering without HTTP routes (API and worker): repositories, the asset registry, work orders and
 * `ENGINEERING_API`. Registers the `ENG_WORK_ORDER` work kind with the operations engine and, where the AI context is
 * loaded, the Engineering Copilot's tools.
 */
@Global()
@Module({
  providers: [
    EngineeringRepositories,
    AssetService,
    WorkOrderService,
    MaintenanceService,
    RestrictionService,
    EngineeringAiTools,
    EngineeringPublicApiService,
    { provide: ENGINEERING_API, useExisting: EngineeringPublicApiService },
  ],
  exports: [
    EngineeringRepositories,
    AssetService,
    WorkOrderService,
    MaintenanceService,
    RestrictionService,
    ENGINEERING_API,
  ],
})
export class EngineeringCoreModule implements OnModuleInit {
  constructor(
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    private readonly aiTools: EngineeringAiTools,
    @Optional() @Inject(AI_TOOL_REGISTRY) private readonly tools?: AiToolRegistrar,
  ) {}
  onModuleInit(): void {
    if (this.tools) this.aiTools.registerInto(this.tools);
    this.ops.registerWorkItemKind({
      code: ENG_WORK_ORDER_KIND,
      module: 'eng',
      descriptionKey: 'eng.work_kind.work_order',
    });
  }
}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [EngineeringCoreModule],
  providers: [CopilotService],
  controllers: [
    EngineeringReferenceController,
    AssetsController,
    WorkOrdersController,
    ProceduresController,
    MaintenanceController,
  ],
})
export class EngineeringModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(ENGINEERING_MANIFEST);
  }
}

/** Worker side: work orders follow their work items; the hourly preventive maintenance sweep on `normal`. */
@Module({ imports: [EngineeringCoreModule] })
export class EngineeringWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly orders: WorkOrderService,
    private readonly maintenance: MaintenanceService,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    for (const def of WorkOrderService.consumes)
      this.consumers.on(def.name, WORK_ORDER_CONSUMER, (envelope) => this.orders.apply(envelope));
    this.consumers.onJob(PM_SWEEP_JOB, async () => {
      await this.maintenance.generateDue();
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('normal').upsertJobScheduler(
      PM_SWEEP_JOB,
      { every: PM_SWEEP_EVERY_MS },
      {
        name: PM_SWEEP_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
    this.logger.info(
      { job: PM_SWEEP_JOB, every_ms: PM_SWEEP_EVERY_MS },
      'engineering schedule armed',
    );
  }
}
