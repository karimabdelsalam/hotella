import { type DynamicModule, Global, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { PLATFORM_MANIFEST } from './platform.manifest';
import { ManifestRegistry } from './registry';

@Global()
@Module({})
export class ManifestModule implements OnApplicationBootstrap {
  constructor(private readonly registry: ManifestRegistry) {}

  /** Registers the platform manifest; domain modules call `registry.register()` in their onModuleInit. */
  static forRoot(): DynamicModule {
    const registry = new ManifestRegistry();
    registry.register(PLATFORM_MANIFEST);
    return {
      module: ManifestModule,
      providers: [{ provide: ManifestRegistry, useValue: registry }],
      exports: [ManifestRegistry],
    };
  }

  /** Runs after every module's onModuleInit registered its manifest; an invalid set stops the boot. */
  onApplicationBootstrap(): void {
    this.registry.assertValid();
  }
}
