import { type DynamicModule, Global, Module } from '@nestjs/common';
import { EnvSecretProvider, SecretResolver, type SecretProvider } from './provider';

@Global()
@Module({})
export class SecretsModule {
  /** Registers providers. Default: env:// only. Production adds the Vault adapter (ADR-0013). */
  static forRoot(
    options: { readonly providers?: ReadonlyArray<SecretProvider>; readonly ttlMs?: number } = {},
  ): DynamicModule {
    const providers = options.providers ?? [new EnvSecretProvider()];
    return {
      module: SecretsModule,
      providers: [
        { provide: SecretResolver, useValue: new SecretResolver(providers, options.ttlMs) },
      ],
      exports: [SecretResolver],
    };
  }
}
