import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { calls, type CallRow } from './schema';

/** Voice calls (BUILD_PLAN 13.4). */
@Injectable()
export class CallRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /** Records a call once per provider call id; undefined for a repeated `call.started`. */
  async insert(values: typeof calls.$inferInsert): Promise<CallRow | undefined> {
    const [row] = await this.x.insert(calls).values(values).onConflictDoNothing().returning();
    return row;
  }

  /** The call of a gateway's call id, locked for the event being applied. */
  byProviderId(
    scope: TenantScope,
    channelId: string,
    providerCallId: string,
  ): Promise<CallRow | undefined> {
    return this.x
      .select()
      .from(calls)
      .where(
        tenantWhere(
          calls,
          scope,
          eq(calls.channelId, channelId),
          eq(calls.providerCallId, providerCallId),
        ),
      )
      .for('update')
      .then((r) => r[0]);
  }

  /** The call the platform is answering in a conversation right now, if any. */
  liveOfConversation(scope: TenantScope, conversationId: string): Promise<CallRow | undefined> {
    return this.x
      .select()
      .from(calls)
      .where(
        tenantWhere(
          calls,
          scope,
          eq(calls.conversationId, conversationId),
          eq(calls.status, 'ANSWERED'),
        ),
      )
      .for('update')
      .then((r) => r[0]);
  }

  /** The same, without a lock (read transactions). */
  liveOfConversationRead(scope: TenantScope, conversationId: string): Promise<CallRow | undefined> {
    return this.x
      .select()
      .from(calls)
      .where(
        tenantWhere(
          calls,
          scope,
          eq(calls.conversationId, conversationId),
          eq(calls.status, 'ANSWERED'),
        ),
      )
      .then((r) => r[0]);
  }

  async update(
    scope: TenantScope,
    id: string,
    values: Partial<typeof calls.$inferInsert>,
  ): Promise<CallRow> {
    const [row] = await this.x
      .update(calls)
      .set({ ...values, version: sql`${calls.version} + 1`, updatedAt: new Date() })
      .where(tenantWhere(calls, scope, eq(calls.id, id)))
      .returning();
    return row!;
  }

  /** A property's calls, newest first (keyset on `started_at`). */
  list(scope: PropertyScope, opts: { before?: Date; limit: number }): Promise<CallRow[]> {
    return this.x
      .select()
      .from(calls)
      .where(
        propertyWhere(calls, scope, opts.before ? lt(calls.startedAt, opts.before) : undefined),
      )
      .orderBy(desc(calls.startedAt))
      .limit(opts.limit);
  }
}
