import {
  type DynamicModule,
  Global,
  Module,
  type OnApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { SecretResolver } from '@hotella/platform-secrets';
import { StorageService } from './storage.service';

@Global()
@Module({})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  /**
   * Credentials are SecretRefs in config, resolved through the SecretResolver (ADR-0010): at boot by default (the API
   * fails fast), or with `lazy` when the first request needs them (the worker, which reads photos only for vision).
   */
  static forRoot(options: { readonly lazy?: boolean } = {}): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        {
          provide: StorageService,
          inject: [APP_CONFIG, SecretResolver],
          useFactory: async (
            config: AppConfig,
            secrets: SecretResolver,
          ): Promise<StorageService> => {
            const at = {
              endpoint: config.storage.endpoint,
              region: config.storage.region,
              bucket: config.storage.bucket,
              forcePathStyle: config.storage.forcePathStyle,
            };
            const resolve = async () => ({
              accessKey: await secrets.resolve(config.storage.accessKeyRef),
              secretKey: await secrets.resolve(config.storage.secretKeyRef),
            });
            return options.lazy
              ? new StorageService({ ...at, credentials: resolve })
              : new StorageService({ ...at, ...(await resolve()) });
          },
        },
      ],
      exports: [StorageService],
    };
  }

  onApplicationShutdown(): void {
    this.storage.destroy();
  }
}
