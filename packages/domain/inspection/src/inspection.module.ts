import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { WorkItemStatusChanged } from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { InspectionsController, TemplatesController } from './api/controllers';
import { INSPECTION_FINDING_KIND, InspectionService } from './application/inspection.service';
import { InspectionPublicApiService } from './application/public-api.service';
import { TemplateService } from './application/template.service';
import { InspectionRepositories } from './infrastructure/repositories';
import { INSPECTION_MANIFEST } from './manifest';
import { INSPECTION_API } from './public';

/** Inbox consumer of the worker: findings follow the work opened for them. */
export const FINDING_WORK_CONSUMER = 'inspection.finding-work';

/**
 * Inspections without HTTP routes (API and worker): repositories, templates, inspections and `INSPECTION_API`.
 * Registers the `INSPECTION_FINDING` work kind with the operations engine.
 */
@Global()
@Module({
  providers: [
    InspectionRepositories,
    TemplateService,
    InspectionService,
    InspectionPublicApiService,
    { provide: INSPECTION_API, useExisting: InspectionPublicApiService },
  ],
  exports: [InspectionRepositories, TemplateService, InspectionService, INSPECTION_API],
})
export class InspectionCoreModule implements OnModuleInit {
  constructor(@Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi) {}
  onModuleInit(): void {
    this.ops.registerWorkItemKind({
      code: INSPECTION_FINDING_KIND,
      module: 'inspection',
      descriptionKey: 'inspection.work_kind.finding',
    });
  }
}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [InspectionCoreModule],
  controllers: [TemplatesController, InspectionsController],
})
export class InspectionModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(INSPECTION_MANIFEST);
  }
}

/** Worker side: a finding is resolved when the work opened for it is. */
@Module({ imports: [InspectionCoreModule] })
export class InspectionWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly inspections: InspectionService,
  ) {}
  onModuleInit(): void {
    this.consumers.on(WorkItemStatusChanged.name, FINDING_WORK_CONSUMER, (envelope) =>
      this.inspections.followWork(envelope),
    );
  }
}
