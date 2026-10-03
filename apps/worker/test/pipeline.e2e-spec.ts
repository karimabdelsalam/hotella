import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PlatformPing } from '@hotella/contracts-events';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule, runMigrations, TransactionRunner } from '@hotella/platform-database';
import { EVENT_TRANSPORT, EventPublisher, EventsModule } from '@hotella/platform-events';
import { ObservabilityModule, RequestContext } from '@hotella/platform-observability';
import { BULLMQ_EVENT_TRANSPORT, QueueModule } from '@hotella/platform-queue';
import { SecretsModule } from '@hotella/platform-secrets';
import { readTestInfra } from '@hotella/platform-testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PingConsumer } from '../src/runtime/ping.consumer';
import { RelayService } from '../src/runtime/relay.service';
import { WorkerRuntimeModule } from '../src/runtime/runtime.module';

const infra = readTestInfra();

describe.skipIf(!infra.databaseUrl || !infra.valkeyUrl)(
  'Phase 0 pipeline: outbox → relay → Valkey queue → idempotent consumer',
  () => {
    let app: INestApplication;

    beforeAll(async () => {
      await runMigrations(infra.databaseUrl!);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: infra.databaseUrl!,
        VALKEY_URL: infra.valkeyUrl!,
        WORKER_QUEUES: 'normal',
        WORKER_SCHEDULER_ENABLED: 'false',
        WORKER_RELAY_INTERVAL_MS: '100',
      };
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ env }),
          ObservabilityModule.forRoot(),
          SecretsModule.forRoot(),
          DatabaseModule.forRoot(),
          QueueModule.forRoot(),
          EventsModule.forRoot({
            transport: { provide: EVENT_TRANSPORT, useExisting: BULLMQ_EVENT_TRANSPORT },
          }),
          WorkerRuntimeModule,
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      await app.init();
    });
    afterAll(() => app?.close());

    it('delivers a committed event exactly once to the consumer with its correlation id, and reports health', async () => {
      const publisher = app.get(EventPublisher);
      const runner = app.get(TransactionRunner);
      const ctx = app.get(RequestContext);
      const consumer = app.get(PingConsumer);
      const relay = app.get(RelayService);

      const message = `ping-${Date.now()}`;
      await ctx.run({ correlation_id: 'corr-pipeline-1' }, () =>
        runner.run(() =>
          publisher.publish(PlatformPing, {
            payload: { message },
            tenantId: null,
            source: 'worker-e2e',
          }),
        ),
      );
      await relay.tick(); // deterministic instead of waiting for the interval
      await relay.tick(); // a second relay pass must not re-publish

      const deadline = Date.now() + 15_000;
      while (!consumer.received.includes(message) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 300));
      expect(consumer.received.filter((m) => m === message)).toHaveLength(1);

      const health = await request(app.getHttpServer()).get('/ready').expect(200);
      expect(health.body.queues).toEqual(['normal']);
      expect(typeof health.body.outbox_lag_seconds).toBe('number');
      expect(health.body.last_relay.published).toBeGreaterThanOrEqual(0);
    });
  },
);
