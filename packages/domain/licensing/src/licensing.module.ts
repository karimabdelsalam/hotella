import { Global, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ENTITLEMENT_STAGE } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import {
  LicenseCatalogController,
  MyEntitlementsController,
  TenantLicenseController,
  TenantOwnLicenseController,
} from './api/controllers';
import { LicenseCatalogService } from './application/catalog.service';
import { EntitlementEngine } from './application/entitlement-engine';
import { EntitlementStage } from './application/entitlement-stage';
import { GrantService } from './application/grant.service';
import { LicenseViewService } from './application/license-view.service';
import { PlanService } from './application/plan.service';
import { SubscriptionService } from './application/subscription.service';
import { CatalogRepositories } from './infrastructure/repositories';
import { TenantLicenseRepositories } from './infrastructure/tenant-repositories';
import { LICENSING_MANIFEST } from './manifest';
import { ENTITLEMENT_API } from './public';

/**
 * Licensing without HTTP routes (API and worker): the catalog sync, the entitlement engine (`ENTITLEMENT_API` for
 * other contexts) and the services behind the control plane.
 */
@Global()
@Module({
  providers: [
    CatalogRepositories,
    TenantLicenseRepositories,
    LicenseCatalogService,
    PlanService,
    EntitlementEngine,
    { provide: ENTITLEMENT_API, useExisting: EntitlementEngine },
    SubscriptionService,
    GrantService,
    LicenseViewService,
  ],
  exports: [
    CatalogRepositories,
    LicenseCatalogService,
    PlanService,
    EntitlementEngine,
    ENTITLEMENT_API,
    SubscriptionService,
    GrantService,
    LicenseViewService,
  ],
})
export class LicensingCoreModule {
  /** `AuthModule.forRoot({ stages: [LicensingCoreModule.entitlementStage()] })` — action-gate stage 2 (Spec §60). */
  static entitlementStage(): Provider {
    return {
      provide: ENTITLEMENT_STAGE,
      inject: [EntitlementEngine, ManifestRegistry],
      useFactory: (engine: EntitlementEngine, manifests: ManifestRegistry) =>
        new EntitlementStage(engine, manifests),
    };
  }
}

/** Control-plane and tenant routes and the manifest, for the API process. */
@Module({
  imports: [LicensingCoreModule],
  controllers: [
    LicenseCatalogController,
    TenantLicenseController,
    TenantOwnLicenseController,
    MyEntitlementsController,
  ],
})
export class LicensingModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(LICENSING_MANIFEST);
  }
}
