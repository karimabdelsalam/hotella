import { Inject, Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@hotella/contracts-events';
import { DATABASE, type Database, withTransaction } from '@hotella/platform-database';
import { inbox } from './schema';

export type ProcessOutcome = 'processed' | 'duplicate';

/**
 * Exactly-once *effect* on top of at-least-once delivery: the inbox row is inserted in the same
 * transaction as the handler's writes. A second delivery finds the row and skips (Spec §50).
 */
@Injectable()
export class IdempotentConsumer {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async once(
    consumer: string,
    envelope: EventEnvelope,
    handler: (envelope: EventEnvelope) => Promise<void>,
  ): Promise<ProcessOutcome> {
    return withTransaction(this.db, async (tx) => {
      const inserted = await tx
        .insert(inbox)
        .values({ eventId: envelope.event_id, consumer })
        .onConflictDoNothing()
        .returning({ eventId: inbox.eventId });
      if (inserted.length === 0) return 'duplicate';
      await handler(envelope);
      return 'processed';
    });
  }
}
