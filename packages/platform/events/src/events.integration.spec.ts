import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import { PlatformPing, type EventEnvelope } from '@hotella/contracts-events';
import {
  DATABASE,
  DatabaseModule,
  type Database,
  isolatedDatabaseUrl,
  runMigrations,
  TransactionRunner,
} from '@hotella/platform-database';
import { ObservabilityModule, RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainEventBus } from './domain-event-bus';
import { EventsModule } from './events.module';
import { IdempotentConsumer } from './idempotency';
import { EventPublisher, OutboxRequiresTransactionError } from './publisher';
import { backoffMs, EVENT_TRANSPORT, OutboxRelay, type EventTransport } from './relay';
import { EventRetention } from './retention';
import { inbox, outbox } from './schema';

class FakeTransport implements EventTransport {
  published: EventEnvelope[] = [];
  failNext = 0;
  async publish(envelope: EventEnvelope): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('transport down');
    }
    this.published.push(envelope);
  }
}

describe('backoff', () => {
  it('doubles and caps at five minutes', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(30)).toBe(300_000);
  });
});

describe.skipIf(needsInfra())(
  `outbox / relay / inbox against PostgreSQL (${infraSkipReason()})`,
  () => {
    let url: string;
    const transport = new FakeTransport();
    let db: Database;
    let publisher: EventPublisher;
    let runner: TransactionRunner;
    let relay: OutboxRelay;
    let inboxSvc: IdempotentConsumer;
    let bus: DomainEventBus;
    let ctx: RequestContext;
    let close: () => Promise<void>;
    let appRef: INestApplication;

    beforeAll(async () => {
      // Own database: relay assertions are about the whole outbox, which other suites write to in parallel.
      url = await isolatedDatabaseUrl(readTestInfra().databaseUrl!, 'events');
      await runMigrations(url);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        VALKEY_URL: 'redis://127.0.0.1:1',
      };
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ env }),
          ObservabilityModule.forRoot(),
          DatabaseModule.forRoot(),
          EventsModule.forRoot({ transport: { provide: EVENT_TRANSPORT, useValue: transport } }),
        ],
      }).compile();
      const app = ref.createNestApplication({ logger: false });
      await app.init();
      db = app.get(DATABASE);
      publisher = app.get(EventPublisher);
      runner = app.get(TransactionRunner);
      relay = app.get(OutboxRelay);
      inboxSvc = app.get(IdempotentConsumer);
      bus = app.get(DomainEventBus);
      ctx = app.get(RequestContext);
      close = () => app.close();
      appRef = app;
    });
    afterAll(() => close?.());

    it('refuses to publish outside a transaction', async () => {
      await expect(
        publisher.publish(PlatformPing, {
          payload: { message: 'x' },
          tenantId: null,
          source: 'test',
        }),
      ).rejects.toThrow(OutboxRequiresTransactionError);
    });

    it('writes the outbox row atomically with the business transaction and emits on the in-context bus', async () => {
      const seen: string[] = [];
      const off = bus.on(PlatformPing, async (e) => {
        seen.push(e.payload.message);
      });
      const envelope = await ctx.run({ correlation_id: 'corr-outbox-1' }, () =>
        runner.run(() =>
          publisher.publish(PlatformPing, {
            payload: { message: 'committed' },
            tenantId: null,
            source: 'test',
            aggregate: { type: 'ping', id: 'p1' },
          }),
        ),
      );
      off();
      expect(seen).toEqual(['committed']);
      const [row] = await db.select().from(outbox).where(eq(outbox.id, envelope.event_id));
      expect(row).toMatchObject({
        eventName: 'platform.ping.requested.v1',
        deliveryQueue: 'normal',
        correlationId: 'corr-outbox-1',
        publishedAt: null,
        aggregateType: 'ping',
      });
      expect(row!.envelope).toMatchObject({
        correlation_id: 'corr-outbox-1',
        payload: { message: 'committed' },
      });
    });

    it('rolls the outbox row back with the business transaction', async () => {
      let id = '';
      await expect(
        runner.run(async () => {
          const env = await publisher.publish(PlatformPing, {
            payload: { message: 'rolled back' },
            tenantId: null,
            source: 'test',
          });
          id = env.event_id;
          throw new Error('business failure');
        }),
      ).rejects.toThrow('business failure');
      expect(await db.select().from(outbox).where(eq(outbox.id, id))).toHaveLength(0);
    });

    it('relay publishes pending rows once, retries failures with backoff, and reports lag', async () => {
      await runner.run(() =>
        publisher.publish(PlatformPing, {
          payload: { message: 'relay-1' },
          tenantId: null,
          source: 'test',
        }),
      );
      const env2 = await runner.run(() =>
        publisher.publish(PlatformPing, {
          payload: { message: 'relay-2' },
          tenantId: null,
          source: 'test',
        }),
      );
      expect(await relay.lagSeconds()).toBeGreaterThanOrEqual(0);

      transport.failNext = 1; // first claimed row fails once
      const r1 = await relay.relayOnce(10);
      expect(r1.claimed).toBeGreaterThanOrEqual(2);
      expect(r1.failed).toBe(1);
      const failedRow = (await relay.pending(10)).find((r) => r.attempts === 1);
      expect(failedRow?.lastError).toBe('transport down');
      expect(failedRow!.availableAt.getTime()).toBeGreaterThan(Date.now()); // backed off

      const r2 = await relay.relayOnce(10); // the backed-off row is not yet available
      expect(r2.claimed).toBe(0);

      const publishedIds = new Set(transport.published.map((e) => e.event_id));
      expect(publishedIds.size).toBe(transport.published.length); // never twice
      expect(
        publishedIds.has(env2.event_id) ||
          (await db.select().from(outbox).where(eq(outbox.id, env2.event_id)))[0]!.attempts === 1,
      ).toBe(true);
    });

    it('idempotent consumer processes an event once across duplicate deliveries', async () => {
      const envelope = await runner.run(() =>
        publisher.publish(PlatformPing, {
          payload: { message: 'dup' },
          tenantId: null,
          source: 'test',
        }),
      );
      let calls = 0;
      const handler = async (): Promise<void> => {
        calls++;
      };
      expect(await inboxSvc.once('test.consumer', envelope, handler)).toBe('processed');
      expect(await inboxSvc.once('test.consumer', envelope, handler)).toBe('duplicate');
      expect(await inboxSvc.once('other.consumer', envelope, handler)).toBe('processed'); // per consumer
      expect(calls).toBe(2);
    });

    it('does not record the inbox row when the handler fails (so the retry is processed)', async () => {
      const envelope = await runner.run(() =>
        publisher.publish(PlatformPing, {
          payload: { message: 'fail' },
          tenantId: null,
          source: 'test',
        }),
      );
      await expect(
        inboxSvc.once('failing.consumer', envelope, async () =>
          Promise.reject(new Error('handler boom')),
        ),
      ).rejects.toThrow('handler boom');
      let calls = 0;
      expect(
        await inboxSvc.once('failing.consumer', envelope, async () => {
          calls++;
        }),
      ).toBe('processed');
      expect(calls).toBe(1);
    });

    it('purges published outbox rows and old inbox rows after their retention, never pending ones', async () => {
      const pending = await runner.run(() =>
        publisher.publish(PlatformPing, {
          payload: { message: 'keep' },
          tenantId: null,
          source: 'test',
        }),
      );
      const count = async () => ({
        published: (await db.select().from(outbox).where(isNotNull(outbox.publishedAt))).length,
        pending: (await db.select().from(outbox).where(isNull(outbox.publishedAt))).length,
        inbox: (await db.select().from(inbox)).length,
      });
      const before = await count();
      expect(before.published).toBeGreaterThan(0);
      expect(before.inbox).toBeGreaterThan(0);
      const retention = appRef.get(EventRetention);
      // Nothing is old enough yet.
      expect(await retention.purge({ outboxDays: 7, inboxDays: 30 })).toEqual({
        outbox: 0,
        inbox: 0,
      });
      const later = new Date(Date.now() + 31 * 24 * 3600_000);
      const purged = await retention.purge({ outboxDays: 7, inboxDays: 30 }, later);
      expect(purged).toEqual({ outbox: before.published, inbox: before.inbox });
      const after = await count();
      expect(after).toEqual({ published: 0, pending: before.pending, inbox: 0 });
      expect((await db.select().from(outbox).where(eq(outbox.id, pending.event_id))).length).toBe(
        1,
      );
    });
  },
);
