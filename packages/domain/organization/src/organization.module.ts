import { Module, type OnModuleInit } from '@nestjs/common';
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
import { ORGANIZATION_API } from './public';
import { OrganizationPublicApiService } from './public-api.service';

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
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(ORGANIZATION_MANIFEST);
  }
}
