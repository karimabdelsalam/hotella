import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  notificationDeliveries,
  notificationIntents,
  notificationPreferences,
  type NotificationDeliveryRow,
  type NotificationIntentRow,
  type NotificationPreferenceRow,
} from './schema';

/** Tenant-filtered data access for notification intents, deliveries and preferences (CLAUDE.md rule 1). */
@Injectable()
export class NotificationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insertIntent(
    values: typeof notificationIntents.$inferInsert,
  ): Promise<NotificationIntentRow> {
    const [row] = await this.x.insert(notificationIntents).values(values).returning();
    return row!;
  }
  intentForUpdate(scope: TenantScope, id: string): Promise<NotificationIntentRow | undefined> {
    return this.x
      .select()
      .from(notificationIntents)
      .where(tenantWhere(notificationIntents, scope, eq(notificationIntents.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  intents(scope: TenantScope, ids: readonly string[]): Promise<NotificationIntentRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(notificationIntents)
      .where(tenantWhere(notificationIntents, scope, inArray(notificationIntents.id, [...ids])));
  }
  async markDispatched(scope: TenantScope, id: string, at: Date): Promise<void> {
    await this.x
      .update(notificationIntents)
      .set({ dispatchedAt: at })
      .where(tenantWhere(notificationIntents, scope, eq(notificationIntents.id, id)));
  }

  /** Inserts deliveries once per (intent, person, channel): a redelivered dispatch adds nothing. */
  async insertDeliveries(
    values: Array<typeof notificationDeliveries.$inferInsert>,
  ): Promise<number> {
    if (values.length === 0) return 0;
    const rows = await this.x
      .insert(notificationDeliveries)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id });
    return rows.length;
  }
  deliveriesOfIntent(scope: TenantScope, intentId: string): Promise<NotificationDeliveryRow[]> {
    return this.x
      .select()
      .from(notificationDeliveries)
      .where(
        tenantWhere(notificationDeliveries, scope, eq(notificationDeliveries.intentId, intentId)),
      )
      .orderBy(asc(notificationDeliveries.userId), asc(notificationDeliveries.channel));
  }
  /** Due e-mail (and future external-channel) deliveries across tenants, locked and skipped by other workers. */
  claimDue(now: Date, limit: number): Promise<NotificationDeliveryRow[]> {
    return this.x
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.status, 'PENDING'),
          lte(notificationDeliveries.nextAttemptAt, now),
        ),
      )
      .orderBy(asc(notificationDeliveries.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }
  async updateDelivery(
    scope: TenantScope,
    id: string,
    values: Partial<typeof notificationDeliveries.$inferInsert>,
  ): Promise<void> {
    await this.x
      .update(notificationDeliveries)
      .set(values)
      .where(tenantWhere(notificationDeliveries, scope, eq(notificationDeliveries.id, id)));
  }
  /** A person's in-app inbox at a property, newest first. */
  inbox(
    scope: PropertyScope,
    userId: string,
    filter: { unreadOnly: boolean; limit: number },
  ): Promise<NotificationDeliveryRow[]> {
    return this.x
      .select()
      .from(notificationDeliveries)
      .where(
        tenantWhere(
          notificationDeliveries,
          scope,
          eq(notificationDeliveries.propertyId, scope.propertyId),
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.channel, 'IN_APP'),
          filter.unreadOnly ? isNull(notificationDeliveries.readAt) : undefined,
        ),
      )
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(filter.limit);
  }
  /** Marks one of the person's own in-app notifications read; false when it is not theirs. */
  async markRead(scope: PropertyScope, id: string, userId: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(notificationDeliveries)
      .set({
        readAt: sql`coalesce(${notificationDeliveries.readAt}, ${at.toISOString()}::timestamptz)`,
      })
      .where(
        tenantWhere(
          notificationDeliveries,
          scope,
          eq(notificationDeliveries.id, id),
          eq(notificationDeliveries.propertyId, scope.propertyId),
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.channel, 'IN_APP'),
        ),
      )
      .returning({ id: notificationDeliveries.id });
    return rows.length > 0;
  }

  preferences(
    scope: TenantScope,
    userIds: readonly string[],
  ): Promise<NotificationPreferenceRow[]> {
    if (userIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(notificationPreferences)
      .where(
        tenantWhere(
          notificationPreferences,
          scope,
          inArray(notificationPreferences.userId, [...userIds]),
        ),
      )
      .orderBy(asc(notificationPreferences.category), asc(notificationPreferences.channel));
  }
  async upsertPreference(values: typeof notificationPreferences.$inferInsert): Promise<void> {
    await this.x
      .insert(notificationPreferences)
      .values(values)
      .onConflictDoUpdate({
        target: [
          notificationPreferences.tenantId,
          notificationPreferences.userId,
          notificationPreferences.category,
          notificationPreferences.channel,
        ],
        set: { enabled: values.enabled, updatedAt: sql`now()` },
      });
  }
}
