import { Global, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { PROPERTY_SCOPE_VERIFIER, type PropertyScopeVerifier } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { SettingsRegistry } from '@hotella/platform-settings';
import { ORGANIZATION_SETTINGS } from './domain/settings';
import {
  BrandingController,
  PropertiesController,
  PropertyBrandController,
  TenantsController,
} from './api/controllers';
import { BrandAssetService } from './application/brand-assets.service';
import {
  BrandingService,
  DepartmentService,
  LocationService,
  OrganizationService,
  PropertyService,
  RoomService,
  TenantService,
} from './application/services';
import { OrganizationRepositories } from './infrastructure/repositories';
import { ORGANIZATION_MANIFEST } from './manifest';
import { ORGANIZATION_API, type OrganizationPublicApi } from './public';
import { OrganizationPublicApiService } from './public-api.service';
import { OrganizationUsageGauge } from './application/usage-gauge';

/**
 * Lookups of other contexts in background processes (the worker): ORGANIZATION_API without HTTP routes. Branding
 * resolution needs the full module and is not available here. Never import both modules in one application.
 */
@Global()
@Module({
  providers: [
    OrganizationRepositories,
    OrganizationPublicApiService,
    { provide: ORGANIZATION_API, useExisting: OrganizationPublicApiService },
    OrganizationUsageGauge,
  ],
  exports: [ORGANIZATION_API],
})
export class OrganizationCoreModule {}

/** Global so other contexts can inject ORGANIZATION_API (its only export) without importing this module. */
@Global()
@Module({
  controllers: [
    TenantsController,
    PropertiesController,
    BrandingController,
    PropertyBrandController,
  ],
  providers: [
    OrganizationRepositories,
    TenantService,
    OrganizationService,
    PropertyService,
    LocationService,
    RoomService,
    DepartmentService,
    BrandingService,
    BrandAssetService,
    OrganizationPublicApiService,
    { provide: ORGANIZATION_API, useExisting: OrganizationPublicApiService },
  ],
  exports: [ORGANIZATION_API],
})
export class OrganizationModule implements OnModuleInit {
  /** `AuthModule.forRoot({ propertyVerifier: OrganizationModule.propertyVerifier() })`. */
  static propertyVerifier(): Provider {
    return {
      provide: PROPERTY_SCOPE_VERIFIER,
      inject: [ORGANIZATION_API],
      useFactory: (org: OrganizationPublicApi): PropertyScopeVerifier => ({
        propertyBelongsToTenant: async (propertyId, tenantId) =>
          (await org.getProperty(tenantId, propertyId)) !== null,
        tenantOfProperty: (propertyId) => org.findPropertyTenant(propertyId),
      }),
    };
  }

  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(ORGANIZATION_MANIFEST);
    this.settings.register(...ORGANIZATION_SETTINGS);
  }
}
