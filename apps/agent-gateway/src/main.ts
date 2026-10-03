import './tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AgentGatewayServer } from '@hotella/domain-integrations';
import { PinoNestLogger } from '@hotella/platform-observability';
import { AgentGatewayAppModule } from './app.module';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AgentGatewayAppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoNestLogger));
  app.enableShutdownHooks();
  await app.get(AgentGatewayServer).listen();
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
