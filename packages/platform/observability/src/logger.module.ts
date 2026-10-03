import { type DynamicModule, Global, Inject, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import type { Logger } from 'pino';
import { createLogger } from './logger';
import { PinoNestLogger } from './nest-logger';

/** Injection token for the root pino Logger. Use `@InjectLogger()` in providers. */
export const LOGGER = Symbol('LOGGER');
export const InjectLogger = (): ParameterDecorator => Inject(LOGGER);

@Global()
@Module({})
export class LoggerModule {
  static forRoot(): DynamicModule {
    return {
      module: LoggerModule,
      providers: [
        {
          provide: LOGGER,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): Logger =>
            createLogger({
              name: config.app.name,
              level: config.logging.level,
              pretty: config.env === 'development',
            }),
        },
        {
          provide: PinoNestLogger,
          inject: [LOGGER],
          useFactory: (logger: Logger) => new PinoNestLogger(logger),
        },
      ],
      exports: [LOGGER, PinoNestLogger],
    };
  }
}
