import { Global, Inject, Module, type OnModuleInit, Optional } from '@nestjs/common';
import { ApprovalDecided, IntegrationTelemetryReceived } from '@hotella/contracts-events';
import {
  AI_TOOL_REGISTRY,
  AI_TWIN_LABELS,
  type AiToolRegistrar,
  type TwinLabelRegistrar,
} from '@hotella/domain-ai/public';
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
  RequisitionsController,
  TelemetryController,
  WorkOrdersController,
} from './api/controllers';
import { MaintenanceService } from './application/maintenance.service';
import { RestrictionService } from './application/restriction.service';
import { EngineeringAiTools } from './application/ai-tools';
import { AssetService } from './application/asset.service';
import { CopilotService } from './application/copilot.service';
import { EngineeringPublicApiService } from './application/public-api.service';
import { ENG_WORK_ORDER_KIND, WorkOrderService } from './application/work-order.service';
import { TelemetryService } from './application/telemetry.service';
import { ENG_REQUISITION_APPROVAL, RequisitionService } from './application/requisition.service';
import { RequisitionRepositories } from './infrastructure/requisition-repositories';
import { EngineeringRepositories } from './infrastructure/repositories';
import { TelemetryRepositories } from './infrastructure/telemetry-repositories';
import { ENGINEERING_MANIFEST } from './manifest';
import { ENGINEERING_API } from './public';

/** Inbox consumer of the worker: work orders follow their work items. */
export const WORK_ORDER_CONSUMER = 'eng.work-orders';
/** Inbox consumer of the worker: telemetry batches become minute aggregates and alarms (BUILD_PLAN 13.2). */
export const TELEMETRY_CONSUMER = 'eng.telemetry';
/** Five-minute job: missing-data rules and the aggregate partitions. */
export const TELEMETRY_SWEEP_JOB = 'eng.telemetry.sweep';
const TELEMETRY_SWEEP_EVERY_MS = 5 * 60 * 1000;
/** Hourly job: opens the preventive work of every due plan. */
export const PM_SWEEP_JOB = 'eng.pm.sweep';
const PM_SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Inbox consumers of the worker: the ERP's answer to a requisition, and approvals that were not given. */
export const REQUISITION_CONSUMER = 'eng.requisitions';
export const REQUISITION_APPROVAL_CONSUMER = 'eng.requisition-approvals';

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
    TelemetryRepositories,
    TelemetryService,
    RequisitionRepositories,
    RequisitionService,
    EngineeringPublicApiService,
    { provide: ENGINEERING_API, useExisting: EngineeringPublicApiService },
  ],
  exports: [
    EngineeringRepositories,
    TelemetryService,
    RequisitionService,
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
    private readonly api: EngineeringPublicApiService,
    private readonly requisitions: RequisitionService,
    @Optional() @Inject(AI_TOOL_REGISTRY) private readonly tools?: AiToolRegistrar,
    @Optional() @Inject(AI_TWIN_LABELS) private readonly twinLabels?: TwinLabelRegistrar,
  ) {}
  onModuleInit(): void {
    if (this.tools) this.aiTools.registerInto(this.tools);
    // Assets in the operational twin are named by engineering, for readers who may see assets.
    this.twinLabels?.register({
      kind: 'ASSET',
      permission: 'eng.asset.read',
      labels: async (tenantId, propertyId, ids) => {
        const out = new Map<string, string>();
        for (const id of ids) {
          const asset = await this.api.getAsset(tenantId, propertyId, id);
          if (asset) out.set(id, `${asset.assetNumber} · ${asset.name}`);
        }
        return out;
      },
    });
    this.ops.registerApprovalKind({
      code: ENG_REQUISITION_APPROVAL,
      module: 'eng',
      descriptionKey: 'eng.approval.requisition',
      handler: (approval) => this.requisitions.approved(approval),
    });
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
    TelemetryController,
    RequisitionsController,
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
    private readonly telemetry: TelemetryService,
    private readonly requisitions: RequisitionService,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    for (const def of WorkOrderService.consumes)
      this.consumers.on(def.name, WORK_ORDER_CONSUMER, (envelope) => this.orders.apply(envelope));
    this.consumers.on(IntegrationTelemetryReceived.name, TELEMETRY_CONSUMER, (envelope) =>
      this.telemetry.receive(envelope),
    );
    for (const def of RequisitionService.consumes)
      this.consumers.on(def.name, REQUISITION_CONSUMER, (envelope) =>
        this.requisitions.apply(envelope),
      );
    this.consumers.on(ApprovalDecided.name, REQUISITION_APPROVAL_CONSUMER, async (envelope) => {
      if (!envelope.tenant_id) return;
      const e = ApprovalDecided.parse(envelope);
      if (e.payload.kind !== ENG_REQUISITION_APPROVAL || e.payload.outcome === 'APPROVED') return;
      await this.requisitions.settleApproval(
        envelope.tenant_id,
        e.payload.approval_id,
        e.payload.outcome,
      );
    });
    this.consumers.onJob(PM_SWEEP_JOB, async () => {
      await this.maintenance.generateDue();
    });
    this.consumers.onJob(TELEMETRY_SWEEP_JOB, async () => {
      await this.telemetry.sweep();
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('normal').upsertJobScheduler(
      TELEMETRY_SWEEP_JOB,
      { every: TELEMETRY_SWEEP_EVERY_MS },
      {
        name: TELEMETRY_SWEEP_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
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
