import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { LOGGER, type Logger, PinoNestLogger } from '@hotella/platform-observability';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoNestLogger));
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);

  configureApp(app);
  app.enableShutdownHooks();

  await app.listen(config.app.port, config.app.host);
  logger.info({ port: config.app.port, host: config.app.host, env: config.env }, 'api listening');
}

main().catch((err: unknown) => {
  // The logger may not exist yet; this is the one place a raw error print is acceptable.
  console.error(err);
  process.exit(1);
});
