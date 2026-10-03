import { Global, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { PROPERTY_SCOPE_VERIFIER, type PropertyScopeVerifier } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { BrandingController, PropertiesController, TenantsController } from './api/controllers';
import {
  BrandingService,
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

/** Global so other contexts can inject ORGANIZATION_API (its only export) without importing this module. */
@Global()
@Module({
  controllers: [TenantsController, PropertiesController, BrandingController],
  providers: [
    OrganizationRepositories,
    TenantService,
    OrganizationService,
    PropertyService,
    LocationService,
    RoomService,
    BrandingService,
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
      }),
    };
  }

  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(ORGANIZATION_MANIFEST);
  }
}
