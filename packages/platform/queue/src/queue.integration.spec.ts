import { PlatformPing, createEnvelope } from '@hotella/contracts-events';
import { readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValkeyConnection } from './connection';
import { QueueRegistry } from './registry';
import { BullmqEventTransport } from './transport';
import { createQueueWorker, EventConsumerRegistry } from './worker';
import type { RequestContext } from '@hotella/platform-observability';
import type { IdempotentConsumer } from '@hotella/platform-events';

const infra = readTestInfra();

describe.skipIf(!infra.valkeyUrl)('BullMQ on Valkey', () => {
  const connection = infra.valkeyUrl ? createValkeyConnection(infra.valkeyUrl) : undefined;
  const seen: Array<{ consumer: string; correlation: string | null }> = [];
  // Minimal stand-ins: the context runner records the seed; the "inbox" counts per consumer+event in memory.
  const ctx = {
    snapshot: () => ({
      correlation_id: 'enq-1',
      trace_id: null,
      tenant_id: null,
      property_id: null,
      actor_type: null,
      actor_id: null,
    }),
    run: async (seed: { correlation_id?: string }, fn: () => Promise<unknown>) => {
      seen.push({ consumer: '_ctx', correlation: seed.correlation_id ?? null });
      return fn();
    },
  } as unknown as RequestContext;
  const processed = new Set<string>();
  const idempotency = {
    once: async (
      consumer: string,
      env: { event_id: string },
      handler: (e: unknown) => Promise<void>,
    ) => {
      const k = `${consumer}:${env.event_id}`;
      if (processed.has(k)) return 'duplicate' as const;
      processed.add(k);
      await handler(env);
      return 'processed' as const;
    },
  } as unknown as IdempotentConsumer;
  const logger = {
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: () => undefined,
  } as never;

  let registry: QueueRegistry;
  let worker: ReturnType<typeof createQueueWorker>;

  beforeAll(async () => {
    registry = new QueueRegistry(connection!, ctx);
    await registry
      .queue('normal')
      .obliterate({ force: true })
      .catch(() => undefined);
  });
  afterAll(async () => {
    await worker?.close();
    await registry.close();
    connection?.disconnect(false);
  });

  it('delivers an outbox envelope to the right queue and the worker restores context and dedupes', async () => {
    const consumers = new EventConsumerRegistry();
    const handled: string[] = [];
    consumers.on(PlatformPing.name, 'test.consumer', async (e) => {
      handled.push((e.payload as { message: string }).message);
    });
    worker = createQueueWorker('normal', {
      connection: connection!,
      ctx,
      logger,
      consumers,
      idempotency,
    });
    await worker.waitUntilReady();

    const transport = new BullmqEventTransport(registry);
    const env = createEnvelope(PlatformPing, {
      eventId: '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f02',
      tenantId: null,
      propertyId: null,
      source: 'test',
      correlationId: 'corr-q-1',
      payload: { message: 'hello' },
    });
    await transport.publish(env, { eventName: PlatformPing.name, deliveryQueue: 'normal' });
    await transport.publish(env, { eventName: PlatformPing.name, deliveryQueue: 'normal' }); // duplicate relay: same jobId

    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (handled.length >= 1) {
          clearInterval(t);
          resolve();
        }
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(handled).toEqual(['hello']);
    expect(seen.some((s) => s.correlation === 'corr-q-1')).toBe(true);
  });

  it('runs plain jobs (scheduler ticks, background work) through their handler with the enqueuing context', async () => {
    await worker?.close();
    const consumers = new EventConsumerRegistry();
    const ran: unknown[] = [];
    consumers.onJob<{ n: number }>('test.tick', async (data) => {
      ran.push(data);
    });
    worker = createQueueWorker('normal', {
      connection: connection!,
      ctx,
      logger,
      consumers,
      idempotency,
    });
    await worker.waitUntilReady();
    seen.length = 0;
    await registry.enqueue('normal', 'test.tick', { n: 7 });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (ran.length >= 1) {
          clearInterval(t);
          resolve();
        }
      }, 50);
    });
    expect(ran).toEqual([{ n: 7 }]);
    // The job ran inside the context captured when it was enqueued.
    expect(seen).toContainEqual({ consumer: '_ctx', correlation: 'enq-1' });
  });
});
