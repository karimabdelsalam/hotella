import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { LicenseCatalogController } from './api/controllers';
import { LicenseCatalogService } from './application/catalog.service';
import { PlanService } from './application/plan.service';
import { CatalogRepositories } from './infrastructure/repositories';
import { LICENSING_MANIFEST } from './manifest';

/** Licensing without HTTP routes (API and worker): the catalog sync and the services other contexts call. */
@Global()
@Module({
  providers: [CatalogRepositories, LicenseCatalogService, PlanService],
  exports: [CatalogRepositories, LicenseCatalogService, PlanService],
})
export class LicensingCoreModule {}

/** Control-plane routes and the manifest, for the API process. */
@Module({ imports: [LicensingCoreModule], controllers: [LicenseCatalogController] })
export class LicensingModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(LICENSING_MANIFEST);
  }
}
