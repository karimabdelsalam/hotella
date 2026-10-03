import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import {
  AssetsController,
  EngineeringReferenceController,
  WorkOrdersController,
} from './api/controllers';
import { AssetService } from './application/asset.service';
import { EngineeringPublicApiService } from './application/public-api.service';
import { ENG_WORK_ORDER_KIND, WorkOrderService } from './application/work-order.service';
import { EngineeringRepositories } from './infrastructure/repositories';
import { ENGINEERING_MANIFEST } from './manifest';
import { ENGINEERING_API } from './public';

/** Inbox consumer of the worker: work orders follow their work items. */
export const WORK_ORDER_CONSUMER = 'eng.work-orders';

/**
 * Engineering without HTTP routes (API and worker): repositories, the asset registry, work orders and
 * `ENGINEERING_API`. Registers the `ENG_WORK_ORDER` work kind with the operations engine.
 */
@Global()
@Module({
  providers: [
    EngineeringRepositories,
    AssetService,
    WorkOrderService,
    EngineeringPublicApiService,
    { provide: ENGINEERING_API, useExisting: EngineeringPublicApiService },
  ],
  exports: [EngineeringRepositories, AssetService, WorkOrderService, ENGINEERING_API],
})
export class EngineeringCoreModule implements OnModuleInit {
  constructor(@Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi) {}
  onModuleInit(): void {
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
  controllers: [EngineeringReferenceController, AssetsController, WorkOrdersController],
})
export class EngineeringModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(ENGINEERING_MANIFEST);
  }
}

/** Worker side: work orders follow their work items (exactly once per event). */
@Module({ imports: [EngineeringCoreModule] })
export class EngineeringWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly orders: WorkOrderService,
  ) {}
  onModuleInit(): void {
    for (const def of WorkOrderService.consumes)
      this.consumers.on(def.name, WORK_ORDER_CONSUMER, (envelope) => this.orders.apply(envelope));
  }
}
