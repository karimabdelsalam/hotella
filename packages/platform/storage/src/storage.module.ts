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

  /** Credentials are SecretRefs in config, resolved here through the SecretResolver (ADR-0010). */
  static forRoot(): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        {
          provide: StorageService,
          inject: [APP_CONFIG, SecretResolver],
          useFactory: async (config: AppConfig, secrets: SecretResolver): Promise<StorageService> =>
            new StorageService({
              endpoint: config.storage.endpoint,
              region: config.storage.region,
              bucket: config.storage.bucket,
              forcePathStyle: config.storage.forcePathStyle,
              accessKey: await secrets.resolve(config.storage.accessKeyRef),
              secretKey: await secrets.resolve(config.storage.secretKeyRef),
            }),
        },
      ],
      exports: [StorageService],
    };
  }

  onApplicationShutdown(): void {
    this.storage.destroy();
  }
}
