import {
  type DynamicModule,
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { LOGGER, type Logger } from '@hotella/platform-observability';
import { findLocalesDir, loadCatalog } from './catalog';
import { I18nService } from './i18n.service';
import {
  CurrentLocale,
  LOCALE_PREFERENCE_PROVIDER,
  type LocalePreferenceProvider,
  LocaleResolver,
} from './locale-resolver';

@Global()
@Module({})
export class I18nModule implements NestModule {
  constructor(private readonly resolver: LocaleResolver) {}

  /**
   * Loads the shared catalog once at boot and mounts the locale resolver on every route.
   * `preferences` supplies the actor-preference / property-default steps of the chain (Phase 1 IAM passes
   * `{ provide: LOCALE_PREFERENCE_PROVIDER, useExisting: <its global token> }`).
   */
  static forRoot(
    options: { readonly preferences?: Provider<LocalePreferenceProvider> } = {},
  ): DynamicModule {
    const preferences: Provider = options.preferences ?? {
      provide: LOCALE_PREFERENCE_PROVIDER,
      useValue: null,
    };
    return {
      module: I18nModule,
      providers: [
        preferences,
        {
          provide: I18nService,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: Logger): I18nService => {
            const dir = findLocalesDir(config.i18n.localesDir);
            const catalog = loadCatalog(dir, config.i18n.supportedLocales);
            logger.info(
              {
                locales: config.i18n.supportedLocales,
                dir,
                keys: Object.keys(catalog[config.i18n.defaultLocale] ?? {}).length,
              },
              'locale catalog loaded',
            );
            return new I18nService({
              catalog,
              defaultLocale: config.i18n.defaultLocale,
              supportedLocales: config.i18n.supportedLocales,
              onMissing: (key, locale) => logger.warn({ key, locale }, 'missing translation key'),
            });
          },
        },
        LocaleResolver,
        CurrentLocale,
      ],
      exports: [I18nService, LocaleResolver, CurrentLocale],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((req: never, res: never, next: never) => this.resolver.use(req, res, next))
      .forRoutes('*path');
  }
}
