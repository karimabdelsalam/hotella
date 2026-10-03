import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { AssetsController, EngineeringReferenceController } from './api/controllers';
import { AssetService } from './application/asset.service';
import { EngineeringPublicApiService } from './application/public-api.service';
import { EngineeringRepositories } from './infrastructure/repositories';
import { ENGINEERING_MANIFEST } from './manifest';
import { ENGINEERING_API } from './public';

/** Engineering without HTTP routes (API and worker): repositories, the asset registry and `ENGINEERING_API`. */
@Global()
@Module({
  providers: [
    EngineeringRepositories,
    AssetService,
    EngineeringPublicApiService,
    { provide: ENGINEERING_API, useExisting: EngineeringPublicApiService },
  ],
  exports: [EngineeringRepositories, AssetService, ENGINEERING_API],
})
export class EngineeringCoreModule {}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [EngineeringCoreModule],
  controllers: [EngineeringReferenceController, AssetsController],
})
export class EngineeringModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(ENGINEERING_MANIFEST);
  }
}
