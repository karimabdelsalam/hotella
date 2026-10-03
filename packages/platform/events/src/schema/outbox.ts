import { sql } from 'drizzle-orm';
import { index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { classify, platform } from '@hotella/platform-database';

const schema = platform.platformSchema;

/**
 * Transactional outbox (Spec §50, ADR-0004). A row is written in the SAME transaction as the business
 * change; the relay publishes it to the queue and stamps `published_at`. `id` is the event_id.
 */
export const outbox = classify(
  schema.table(
    'outbox',
    {
      id: uuid('id').primaryKey(),
      eventName: text('event_name').notNull(),
      eventType: text('event_type').notNull(),
      eventVersion: integer('event_version').notNull(),
      tenantId: uuid('tenant_id'),
      propertyId: uuid('property_id'),
      aggregateType: text('aggregate_type'),
      aggregateId: text('aggregate_id'),
      deliveryQueue: text('delivery_queue').notNull(),
      envelope: jsonb('envelope').notNull(),
      correlationId: text('correlation_id'),
      occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
      availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
      publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
      attempts: integer('attempts').notNull().default(0),
      lastError: text('last_error'),
    },
    (t) => [
      index('outbox_pending_idx')
        .on(t.availableAt, t.createdAt)
        .where(sql`${t.publishedAt} IS NULL`),
      index('outbox_aggregate_idx').on(t.aggregateType, t.aggregateId),
    ],
  ),
  {
    id: 'INTERNAL',
    eventName: 'INTERNAL',
    eventType: 'INTERNAL',
    eventVersion: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    aggregateType: 'INTERNAL',
    aggregateId: 'INTERNAL',
    deliveryQueue: 'INTERNAL',
    // Payloads may carry guest data; treated as CONFIDENTIAL and never logged whole.
    envelope: 'CONFIDENTIAL',
    correlationId: 'INTERNAL',
    occurredAt: 'INTERNAL',
    createdAt: 'INTERNAL',
    availableAt: 'INTERNAL',
    publishedAt: 'INTERNAL',
    attempts: 'INTERNAL',
    lastError: 'INTERNAL',
  },
);

/** Inbox for idempotent consumers (Spec §50): one row per (event, consumer); duplicates become no-ops. */
export const inbox = classify(
  schema.table(
    'inbox',
    {
      eventId: uuid('event_id').notNull(),
      consumer: text('consumer').notNull(),
      processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.eventId, t.consumer] })],
  ),
  { eventId: 'INTERNAL', consumer: 'INTERNAL', processedAt: 'INTERNAL' },
);

export type OutboxRow = typeof outbox.$inferSelect;
