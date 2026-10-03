import { type DynamicModule, Module } from '@nestjs/common';
import { type AppConfig, loadConfig } from './schema';

/** Injection token for the validated AppConfig. */
export const APP_CONFIG = Symbol('APP_CONFIG');

@Module({})
export class ConfigModule {
  /**
   * Reads process.env once at boot, validates it and exposes APP_CONFIG globally.
   * This is the single place in the codebase allowed to read process.env (lint-enforced).
   */
  static forRoot(
    options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
  ): DynamicModule {
    const config = loadConfig(options.env ?? process.env);
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

export type { AppConfig };
