import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { EnvSecretProvider, SecretResolver, type SecretProvider } from './provider';
import { VaultKvSecretProvider } from './vault-provider';

/** env:// always; vault:// when SECRETS_VAULT_ADDR is configured (OpenBao or HashiCorp Vault, KV v2). */
export function providersFromConfig(config: AppConfig): SecretProvider[] {
  const providers: SecretProvider[] = [new EnvSecretProvider()];
  const v = config.secrets.vault;
  if (v)
    providers.push(
      new VaultKvSecretProvider({
        address: v.address,
        namespace: v.namespace,
        auth:
          v.auth === 'token'
            ? { method: 'token', tokenFile: v.tokenFile! }
            : {
                method: 'approle',
                roleIdFile: v.roleIdFile!,
                secretIdFile: v.secretIdFile!,
                mount: v.approleMount,
              },
      }),
    );
  return providers;
}

@Global()
@Module({})
export class SecretsModule {
  /** Registers providers: explicit ones (tests), else env:// plus the KV v2 store from configuration (ADR-0013). */
  static forRoot(
    options: { readonly providers?: ReadonlyArray<SecretProvider>; readonly ttlMs?: number } = {},
  ): DynamicModule {
    return {
      module: SecretsModule,
      providers: [
        options.providers
          ? {
              provide: SecretResolver,
              useValue: new SecretResolver(options.providers, options.ttlMs),
            }
          : {
              provide: SecretResolver,
              inject: [APP_CONFIG],
              useFactory: (config: AppConfig) =>
                new SecretResolver(providersFromConfig(config), options.ttlMs),
            },
      ],
      exports: [SecretResolver],
    };
  }
}
