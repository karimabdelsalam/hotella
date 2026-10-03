import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { OperationsController } from './api/controllers';
import { OperationsQueryService } from './application/queries';
import { TaskService } from './application/task.service';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import { OperationsRepositories } from './infrastructure/repositories';
import { OPERATIONS_MANIFEST } from './manifest';
import { OPERATIONS_API } from './public';
import { OperationsPublicApiService } from './public-api.service';

/**
 * The engine without HTTP routes: repositories, the kind registry and OPERATIONS_API. Global so every module can
 * inject OPERATIONS_API and register its work-item kinds; the worker imports it for timers and consumers.
 */
@Global()
@Module({
  providers: [
    OperationsRepositories,
    WorkItemKindRegistry,
    WorkService,
    OperationsPublicApiService,
    { provide: OPERATIONS_API, useExisting: OperationsPublicApiService },
  ],
  exports: [OPERATIONS_API, WorkService, WorkItemKindRegistry, OperationsRepositories],
})
export class OperationsCoreModule {}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [OperationsCoreModule],
  controllers: [OperationsController],
  providers: [OperationsQueryService, TaskService],
})
export class OperationsModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(OPERATIONS_MANIFEST);
  }
}
