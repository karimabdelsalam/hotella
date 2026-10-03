import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import {
  CatalogAdminController,
  GuestCatalogController,
  PropertyCatalogController,
} from './api/controllers';
import { GuestRequestsController, StaffRequestsController } from './api/request.controllers';
import { CatalogAdminService } from './application/admin.service';
import { CatalogReader } from './application/catalog-reader';
import { RequestLifecycle, SERVICE_REQUEST_KIND } from './application/request-lifecycle';
import { RequestNotifier } from './application/request-notifier';
import { ServiceRequestService } from './application/request.service';
import { StarterCatalogService } from './application/starter';
import { CATALOG_SETTINGS } from './domain/settings';
import { RequestRepositories } from './infrastructure/request-repositories';
import { CatalogRepositories } from './infrastructure/repositories';
import { CATALOG_MANIFEST } from './manifest';
import { CATALOG_API } from './public';
import { CatalogPublicApiService } from './public-api.service';

/** Inbox consumer name: the request follows its work item, the stay and the guest (exactly once per event). */
export const SERVICE_REQUEST_CONSUMER = 'catalog.service-requests';

/**
 * The catalog context without HTTP routes (API and worker): repositories, the catalog reader and the request
 * lifecycle. Registers the `SERVICE_REQUEST` work kind with the operations engine.
 */
@Global()
@Module({
  providers: [
    CatalogRepositories,
    RequestRepositories,
    CatalogReader,
    RequestNotifier,
    RequestLifecycle,
  ],
  exports: [CatalogRepositories, RequestRepositories, CatalogReader, RequestLifecycle],
})
export class CatalogCoreModule implements OnModuleInit {
  constructor(@Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi) {}
  onModuleInit(): void {
    this.ops.registerWorkItemKind({
      code: SERVICE_REQUEST_KIND,
      module: 'catalog',
      descriptionKey: 'catalog.work_kind.service_request',
    });
  }
}

/**
 * Staff and guest API, settings, manifest and `CATALOG_API` (global, for the contexts composed in the API process).
 * Creating requests goes through the ActionGate, which the API process provides.
 */
@Global()
@Module({
  imports: [CatalogCoreModule],
  controllers: [
    CatalogAdminController,
    PropertyCatalogController,
    GuestCatalogController,
    GuestRequestsController,
    StaffRequestsController,
  ],
  providers: [
    CatalogAdminService,
    StarterCatalogService,
    ServiceRequestService,
    CatalogPublicApiService,
    { provide: CATALOG_API, useExisting: CatalogPublicApiService },
  ],
  exports: [CATALOG_API, ServiceRequestService],
})
export class CatalogModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(CATALOG_MANIFEST);
    this.settings.register(...CATALOG_SETTINGS);
  }
}

/** Worker side: requests follow their work item, are withdrawn when the stay ends, and forget an anonymized guest. */
@Module({ imports: [CatalogCoreModule] })
export class CatalogWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly lifecycle: RequestLifecycle,
  ) {}
  onModuleInit(): void {
    for (const def of RequestLifecycle.consumes)
      this.consumers.on(def.name, SERVICE_REQUEST_CONSUMER, (envelope) =>
        this.lifecycle.apply(envelope),
      );
  }
}
