import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { SettingsRegistry } from '@hotella/platform-settings';
import {
  CatalogAdminController,
  GuestCatalogController,
  PropertyCatalogController,
} from './api/controllers';
import { CatalogAdminService } from './application/admin.service';
import { CatalogReader } from './application/catalog-reader';
import { StarterCatalogService } from './application/starter';
import { CATALOG_SETTINGS } from './domain/settings';
import { CatalogRepositories } from './infrastructure/repositories';
import { CATALOG_MANIFEST } from './manifest';

/** The catalog context without HTTP routes: repositories and the catalog reader (API and worker). */
@Global()
@Module({
  providers: [CatalogRepositories, CatalogReader],
  exports: [CatalogRepositories, CatalogReader],
})
export class CatalogCoreModule {}

/** Staff and guest API, settings and manifest, for the API process. */
@Module({
  imports: [CatalogCoreModule],
  controllers: [CatalogAdminController, PropertyCatalogController, GuestCatalogController],
  providers: [CatalogAdminService, StarterCatalogService],
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
