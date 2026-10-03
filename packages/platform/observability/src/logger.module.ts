import { type DynamicModule, Global, Inject, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import type { Logger } from 'pino';
import { createLogger } from './logger';
import { PinoNestLogger } from './nest-logger';
import { RequestContext, RequestContextModule } from './request-context';

/** Injection token for the root pino Logger. Use `@InjectLogger()` in providers. */
export const LOGGER = Symbol('LOGGER');
export const InjectLogger = (): ParameterDecorator => Inject(LOGGER);

/**
 * Observability root: request context (CLS) + pino logger whose every line carries the context
 * (correlation_id, trace_id, tenant_id, property_id, actor). Import once in each app.
 */
@Global()
@Module({})
export class ObservabilityModule {
  static forRoot(): DynamicModule {
    return {
      module: ObservabilityModule,
      imports: [RequestContextModule.forRoot()],
      providers: [
        {
          provide: LOGGER,
          inject: [APP_CONFIG, RequestContext],
          useFactory: (config: AppConfig, ctx: RequestContext): Logger =>
            createLogger({
              name: config.app.name,
              level: config.logging.level,
              pretty: config.env === 'development',
              contextProvider: () => ctx.snapshot(),
            }),
        },
        {
          provide: PinoNestLogger,
          inject: [LOGGER],
          useFactory: (logger: Logger) => new PinoNestLogger(logger),
        },
      ],
      exports: [LOGGER, PinoNestLogger, RequestContextModule],
    };
  }
}
