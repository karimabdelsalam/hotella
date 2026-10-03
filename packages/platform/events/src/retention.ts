import { Inject, Injectable } from '@nestjs/common';
import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { DATABASE, type Database } from '@hotella/platform-database';
import { inbox, outbox } from './schema';

const DAY = 24 * 3600_000;
const BATCH = 5_000;

export interface RetentionResult {
  readonly outbox: number;
  readonly inbox: number;
}

/**
 * Retention of delivered events (Spec §69): published outbox rows carry full payloads (e.g. canonical PMS events with
 * guest names) and are deleted after `outboxDays`; inbox rows only exist to make redeliveries no-ops and are deleted
 * after `inboxDays`, which must exceed how long a dead-lettered job may wait to be replayed. Unpublished rows are never
 * touched. Deletes run in batches so a backlog never holds long locks.
 */
@Injectable()
export class EventRetention {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async purge(
    policy: { readonly outboxDays: number; readonly inboxDays: number },
    now = new Date(),
  ): Promise<RetentionResult> {
    const outboxBefore = new Date(now.getTime() - policy.outboxDays * DAY);
    const inboxBefore = new Date(now.getTime() - policy.inboxDays * DAY);
    let outboxDeleted = 0;
    for (;;) {
      const ids = await this.db
        .select({ id: outbox.id })
        .from(outbox)
        .where(and(isNotNull(outbox.publishedAt), lt(outbox.publishedAt, outboxBefore)))
        .limit(BATCH);
      if (ids.length === 0) break;
      await this.db.delete(outbox).where(
        inArray(
          outbox.id,
          ids.map((r) => r.id),
        ),
      );
      outboxDeleted += ids.length;
      if (ids.length < BATCH) break;
    }
    const inboxDeleted = await this.db
      .delete(inbox)
      .where(lt(inbox.processedAt, inboxBefore))
      .returning({ eventId: inbox.eventId });
    return { outbox: outboxDeleted, inbox: inboxDeleted.length };
  }
}
