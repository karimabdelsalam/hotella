import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { channelIdentities, channels, type ChannelIdentityRow, type ChannelRow } from './schema';

/** Repositories never accept a query on tenant data without a tenant/property scope (CLAUDE.md rule 1). */
@Injectable()
export class CommsRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- channels ----
  async insertChannel(values: typeof channels.$inferInsert): Promise<ChannelRow> {
    const [row] = await this.x.insert(channels).values(values).returning();
    return row!;
  }
  channel(scope: PropertyScope, id: string): Promise<ChannelRow | undefined> {
    return this.x
      .select()
      .from(channels)
      .where(propertyWhere(channels, scope, eq(channels.id, id)))
      .then((r) => r[0]);
  }
  /** Platform-level lookup for provider webhooks: the channel id in the URL plus the provider signature identify it. */
  channelById(id: string): Promise<ChannelRow | undefined> {
    return this.x
      .select()
      .from(channels)
      .where(eq(channels.id, id))
      .then((r) => r[0]);
  }
  listChannels(scope: PropertyScope): Promise<ChannelRow[]> {
    return this.x
      .select()
      .from(channels)
      .where(propertyWhere(channels, scope))
      .orderBy(asc(channels.type), asc(channels.name));
  }
  activeChannels(scope: PropertyScope, type: ChannelRow['type']): Promise<ChannelRow[]> {
    return this.x
      .select()
      .from(channels)
      .where(propertyWhere(channels, scope, eq(channels.type, type), eq(channels.status, 'ACTIVE')))
      .orderBy(asc(channels.id));
  }
  /** Optimistic update: undefined when the version moved on. */
  async updateChannel(
    scope: PropertyScope,
    id: string,
    version: number,
    values: Partial<typeof channels.$inferInsert>,
  ): Promise<ChannelRow | undefined> {
    const [row] = await this.x
      .update(channels)
      .set({ ...values, version: sql`${channels.version} + 1`, updatedAt: new Date() })
      .where(propertyWhere(channels, scope, eq(channels.id, id), eq(channels.version, version)))
      .returning();
    return row;
  }
  /** Health follows send outcomes; returns the row only when the health actually changed. */
  async setHealth(
    scope: TenantScope,
    id: string,
    health: ChannelRow['health'],
    at: Date,
  ): Promise<ChannelRow | undefined> {
    const [row] = await this.x
      .update(channels)
      .set({ health, healthChangedAt: at })
      .where(
        tenantWhere(channels, scope, eq(channels.id, id), sql`${channels.health} <> ${health}`),
      )
      .returning();
    return row;
  }

  // ---- channel identities ----
  identity(
    scope: TenantScope,
    type: ChannelIdentityRow['channelType'],
    identifier: string,
  ): Promise<ChannelIdentityRow | undefined> {
    return this.x
      .select()
      .from(channelIdentities)
      .where(
        tenantWhere(
          channelIdentities,
          scope,
          eq(channelIdentities.channelType, type),
          eq(channelIdentities.identifierNormalized, identifier),
        ),
      )
      .then((r) => r[0]);
  }
  /** Inserts the identity if it is new; either way returns the row (idempotent under concurrency). */
  async upsertIdentity(values: typeof channelIdentities.$inferInsert): Promise<ChannelIdentityRow> {
    const [row] = await this.x
      .insert(channelIdentities)
      .values(values)
      .onConflictDoUpdate({
        target: [
          channelIdentities.tenantId,
          channelIdentities.channelType,
          channelIdentities.identifierNormalized,
        ],
        set: { lastSeenAt: sql`coalesce(excluded.last_seen_at, ${channelIdentities.lastSeenAt})` },
      })
      .returning();
    return row!;
  }
  async updateIdentity(
    scope: TenantScope,
    id: string,
    values: Partial<typeof channelIdentities.$inferInsert>,
  ): Promise<ChannelIdentityRow> {
    const [row] = await this.x
      .update(channelIdentities)
      .set({ ...values, version: sql`${channelIdentities.version} + 1`, updatedAt: new Date() })
      .where(tenantWhere(channelIdentities, scope, eq(channelIdentities.id, id)))
      .returning();
    return row!;
  }
  identitiesOfGuest(scope: TenantScope, guestId: string): Promise<ChannelIdentityRow[]> {
    return this.x
      .select()
      .from(channelIdentities)
      .where(tenantWhere(channelIdentities, scope, eq(channelIdentities.guestId, guestId)))
      .orderBy(asc(channelIdentities.id));
  }
  /** Anonymization: the guest's contact points are removed (identity rows carry nothing else). */
  async deleteIdentitiesOfGuest(scope: TenantScope, guestId: string): Promise<number> {
    const rows = await this.x
      .delete(channelIdentities)
      .where(tenantWhere(channelIdentities, scope, eq(channelIdentities.guestId, guestId)))
      .returning({ id: channelIdentities.id });
    return rows.length;
  }
}
