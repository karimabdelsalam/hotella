import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { DATABASE, type Database } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { outbox, type OutboxRow } from './schema';

/** Where the relay hands envelopes to. Implemented by the queue layer (BullMQ) — or a fake in tests. */
export interface EventTransport {
  publish(
    envelope: EventEnvelope,
    meta: { readonly eventName: string; readonly deliveryQueue: string },
  ): Promise<void>;
}
export const EVENT_TRANSPORT = Symbol('EVENT_TRANSPORT');

export interface RelayResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/** attempt → delay: 1s, 2s, 4s … capped at 5 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 300_000);
}

/**
 * Publishes pending outbox rows to the transport. Rows are claimed with FOR UPDATE SKIP LOCKED so
 * several worker replicas never publish the same row twice; at-least-once delivery overall, so
 * consumers are idempotent (inbox).
 */
@Injectable()
export class OutboxRelay {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EVENT_TRANSPORT) private readonly transport: EventTransport,
    @Optional() @InjectLogger() private readonly logger?: Logger,
  ) {}

  async relayOnce(batchSize = 100): Promise<RelayResult> {
    let published = 0;
    let failed = 0;
    const rows = await this.db.transaction(async (tx) => {
      const claimed = await tx
        .select()
        .from(outbox)
        .where(and(isNull(outbox.publishedAt), lte(outbox.availableAt, sql`now()`)))
        .orderBy(asc(outbox.createdAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });

      for (const row of claimed) {
        try {
          await this.transport.publish(row.envelope as EventEnvelope, {
            eventName: row.eventName,
            deliveryQueue: row.deliveryQueue,
          });
          await tx
            .update(outbox)
            .set({ publishedAt: new Date(), lastError: null })
            .where(eq(outbox.id, row.id));
          published++;
        } catch (err) {
          const attempts = row.attempts + 1;
          const message = err instanceof Error ? err.message : String(err);
          await tx
            .update(outbox)
            .set({
              attempts,
              lastError: message.slice(0, 2000),
              availableAt: new Date(Date.now() + backoffMs(attempts)),
            })
            .where(eq(outbox.id, row.id));
          failed++;
          this.logger?.warn(
            { event_id: row.id, event_name: row.eventName, attempts, err: message },
            'outbox publish failed; will retry',
          );
        }
      }
      return claimed;
    });
    return { claimed: rows.length, published, failed };
  }

  /** Seconds between now and the oldest unpublished row (0 when the outbox is empty). Export as a metric. */
  async lagSeconds(): Promise<number> {
    const r = await this.db.execute<{ lag: string | null }>(
      sql`select extract(epoch from (now() - min(${outbox.createdAt})))::text as lag from ${outbox} where ${outbox.publishedAt} is null`,
    );
    const v = r.rows[0]?.lag;
    return v ? Math.max(0, Math.floor(Number(v))) : 0;
  }

  async pending(limit = 50): Promise<OutboxRow[]> {
    return this.db
      .select()
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(asc(outbox.createdAt))
      .limit(limit);
  }
}
