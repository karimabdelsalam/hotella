import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { LOGGER, type Logger, PinoNestLogger } from '@hotella/platform-observability';
import { WorkerAppModule } from './app.module';

async function main(): Promise<void> {
  const app = await NestFactory.create(WorkerAppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoNestLogger));
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);
  app.enableShutdownHooks();
  await app.listen(config.worker.port, config.app.host);
  logger.info(
    {
      port: config.worker.port,
      queues: config.worker.queues,
      scheduler: config.worker.schedulerEnabled,
    },
    'worker listening',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
