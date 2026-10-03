import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { NotificationService, SlaMonitor } from '@hotella/domain-operations';
import { runMigrations } from '@hotella/platform-database';
import { readTestInfra } from '@hotella/platform-testing';
import { WorkerAppModule } from '../src/app.module';

const infra = readTestInfra();

/**
 * The worker as deployed: every context module it composes must resolve its dependencies and start (a missing
 * provider otherwise only shows when the container boots, e.g. in the pilot).
 */
describe.skipIf(!infra.databaseUrl || !infra.valkeyUrl)('worker composition', () => {
  let app: INestApplication | undefined;
  afterAll(() => app?.close());

  it('boots with the operations engine, its schedules and consumers', async () => {
    await runMigrations(infra.databaseUrl!);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: infra.databaseUrl!,
      VALKEY_URL: infra.valkeyUrl!,
      WORKER_QUEUES: 'normal',
      WORKER_SCHEDULER_ENABLED: 'false',
    };
    const ref = await Test.createTestingModule({
      imports: [WorkerAppModule.forRoot({ env })],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
    expect(app.get(SlaMonitor)).toBeDefined();
    expect(app.get(NotificationService)).toBeDefined();
  });
});
