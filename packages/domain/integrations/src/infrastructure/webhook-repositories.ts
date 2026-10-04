import { Inject, Injectable } from '@nestjs/common';
import { and, arrayContains, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  webhookDeliveries,
  webhookEndpoints,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from './schema';

type DeliveryStatus = WebhookDeliveryRow['status'];

/** Outbound webhooks (BUILD_PLAN 11.5). Tenant data is always read through a tenant scope (CLAUDE.md rule 1). */
@Injectable()
export class WebhookRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- endpoints ----
  async insertEndpoint(values: typeof webhookEndpoints.$inferInsert): Promise<WebhookEndpointRow> {
    const [row] = await this.x.insert(webhookEndpoints).values(values).returning();
    return row!;
  }
  endpoints(scope: TenantScope): Promise<WebhookEndpointRow[]> {
    return this.x
      .select()
      .from(webhookEndpoints)
      .where(tenantWhere(webhookEndpoints, scope))
      .orderBy(asc(webhookEndpoints.createdAt));
  }
  endpoint(scope: TenantScope, id: string, lock = false): Promise<WebhookEndpointRow | undefined> {
    const q = this.x
      .select()
      .from(webhookEndpoints)
      .where(tenantWhere(webhookEndpoints, scope, eq(webhookEndpoints.id, id)));
    return (lock ? q.for('update') : q).then((r) => r[0]);
  }
  async updateEndpoint(
    scope: TenantScope,
    id: string,
    version: number,
    set: Partial<
      Pick<
        WebhookEndpointRow,
        'url' | 'eventTypes' | 'description' | 'status' | 'secretVersion' | 'propertyId'
      >
    >,
  ): Promise<WebhookEndpointRow | undefined> {
    const [row] = await this.x
      .update(webhookEndpoints)
      .set({ ...set, version: version + 1, updatedAt: new Date() })
      .where(
        tenantWhere(
          webhookEndpoints,
          scope,
          eq(webhookEndpoints.id, id),
          eq(webhookEndpoints.version, version),
        ),
      )
      .returning();
    return row;
  }
  /** Active endpoints of a tenant subscribed to an event, for the property it happened at (or tenant-wide). */
  subscribers(
    scope: TenantScope,
    eventName: string,
    propertyId: string | null,
  ): Promise<WebhookEndpointRow[]> {
    return this.x
      .select()
      .from(webhookEndpoints)
      .where(
        tenantWhere(
          webhookEndpoints,
          scope,
          eq(webhookEndpoints.status, 'ACTIVE'),
          arrayContains(webhookEndpoints.eventTypes, [eventName]),
          propertyId
            ? or(isNull(webhookEndpoints.propertyId), eq(webhookEndpoints.propertyId, propertyId))
            : isNull(webhookEndpoints.propertyId),
        ),
      );
  }

  // ---- deliveries ----
  /** Idempotent per endpoint and event: a redelivered event adds nothing. */
  async insertDelivery(values: typeof webhookDeliveries.$inferInsert): Promise<boolean> {
    const rows = await this.x
      .insert(webhookDeliveries)
      .values(values)
      .onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.eventId] })
      .returning({ id: webhookDeliveries.id });
    return rows.length > 0;
  }
  deliveries(
    scope: TenantScope,
    endpointId: string,
    status: DeliveryStatus | undefined,
    limit: number,
  ): Promise<WebhookDeliveryRow[]> {
    return this.x
      .select()
      .from(webhookDeliveries)
      .where(
        tenantWhere(
          webhookDeliveries,
          scope,
          eq(webhookDeliveries.endpointId, endpointId),
          status ? eq(webhookDeliveries.status, status) : undefined,
        ),
      )
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);
  }
  delivery(scope: TenantScope, id: string): Promise<WebhookDeliveryRow | undefined> {
    return this.x
      .select()
      .from(webhookDeliveries)
      .where(tenantWhere(webhookDeliveries, scope, eq(webhookDeliveries.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  /** Back to the queue now, with a fresh attempt budget (replay of a dead or delivered delivery). */
  async requeue(
    scope: TenantScope,
    id: string,
    now: Date,
  ): Promise<WebhookDeliveryRow | undefined> {
    const [row] = await this.x
      .update(webhookDeliveries)
      .set({
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        replays: sql`${webhookDeliveries.replays} + 1`,
        updatedAt: now,
      })
      .where(tenantWhere(webhookDeliveries, scope, eq(webhookDeliveries.id, id)))
      .returning();
    return row;
  }

  /**
   * Claims due deliveries across tenants (the worker runs without a tenant setting): each claimed row counts the
   * attempt and is leased until `leaseUntil`, so a crashed sender's rows come back by themselves and concurrent
   * workers never take the same row (SKIP LOCKED).
   */
  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<WebhookDeliveryRow[]> {
    const due = await this.x
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.status, 'PENDING'), lte(webhookDeliveries.nextAttemptAt, now)),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    return this.x
      .update(webhookDeliveries)
      .set({
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        nextAttemptAt: leaseUntil,
        updatedAt: now,
      })
      .where(
        sql`${webhookDeliveries.id} in (${sql.join(
          due.map((d) => sql`${d.id}`),
          sql`, `,
        )})`,
      )
      .returning();
  }
  /** Endpoint of a claimed delivery (system lookup by id; the delivery already carries its tenant). */
  endpointById(id: string): Promise<WebhookEndpointRow | undefined> {
    return this.x
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .then((r) => r[0]);
  }
  async settle(
    id: string,
    attempts: number,
    set: {
      readonly status: DeliveryStatus;
      readonly nextAttemptAt?: Date;
      /** Gives the attempt back when nothing was sent (paused endpoint). */
      readonly attempts?: number;
      readonly lastStatusCode: number | null;
      readonly lastError: string | null;
      readonly deliveredAt?: Date;
    },
  ): Promise<void> {
    // Only the attempt that claimed the row settles it (a replay in between starts a new count).
    await this.x
      .update(webhookDeliveries)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.attempts, attempts)));
  }
}
