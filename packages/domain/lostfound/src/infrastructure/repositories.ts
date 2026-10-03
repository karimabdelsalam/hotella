import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import type { ItemKind, ItemStatus } from '../domain/items';
import {
  type AiMetadataRow,
  aiMetadata,
  claims,
  type ClaimRow,
  itemHistory,
  type ItemRow,
  items,
  matchCandidates,
  type MatchRow,
} from './schema';

@Injectable()
export class LostFoundRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- items ----
  async nextNumber(scope: PropertyScope): Promise<number> {
    await this.x.execute(
      sql`select pg_advisory_xact_lock(hashtext(${'lostfound.no.' + scope.propertyId}))`,
    );
    const { rows } = await this.x.execute(
      sql`select coalesce(max(number), 0) + 1 as n from lostfound.items where property_id = ${scope.propertyId}`,
    );
    return Number((rows[0] as { n: number | string }).n);
  }
  async insertItem(values: typeof items.$inferInsert): Promise<ItemRow> {
    const [row] = await this.x.insert(items).values(values).returning();
    return row!;
  }
  async item(scope: TenantScope, id: string): Promise<ItemRow | undefined> {
    const [row] = await this.x
      .select()
      .from(items)
      .where(tenantWhere(items, scope, eq(items.id, id)));
    return row;
  }
  async itemForUpdate(scope: TenantScope, id: string): Promise<ItemRow | undefined> {
    const [row] = await this.x
      .select()
      .from(items)
      .where(tenantWhere(items, scope, eq(items.id, id)))
      .for('update');
    return row;
  }
  itemsByIds(scope: TenantScope, ids: readonly string[]): Promise<ItemRow[]> {
    return ids.length
      ? this.x
          .select()
          .from(items)
          .where(tenantWhere(items, scope, inArray(items.id, [...ids])))
      : Promise.resolve([]);
  }
  async updateItem(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<ItemRow, 'status' | 'storageLocation' | 'photoKeys' | 'disposalMethod' | 'closedAt'>
    >,
  ): Promise<ItemRow> {
    const [row] = await this.x
      .update(items)
      .set({ ...patch, updatedAt: new Date(), version: sql`${items.version} + 1` })
      .where(tenantWhere(items, scope, eq(items.id, id)))
      .returning();
    return row!;
  }
  itemsOf(
    scope: PropertyScope,
    filter: {
      kind?: ItemKind;
      statuses?: readonly ItemStatus[];
      retentionDueBy?: string;
    },
  ): Promise<ItemRow[]> {
    return this.x
      .select()
      .from(items)
      .where(
        propertyWhere(
          items,
          scope,
          ...(filter.kind ? [eq(items.kind, filter.kind)] : []),
          ...(filter.statuses ? [inArray(items.status, [...filter.statuses])] : []),
          ...(filter.retentionDueBy ? [lte(items.retentionUntil, filter.retentionDueBy)] : []),
        ),
      )
      .orderBy(desc(items.number))
      .limit(200);
  }
  /** Open items of the other kind and category, the only ones a match can involve. */
  openCounterparts(scope: PropertyScope, item: ItemRow): Promise<ItemRow[]> {
    return this.x
      .select()
      .from(items)
      .where(
        propertyWhere(
          items,
          scope,
          eq(items.kind, item.kind === 'FOUND' ? 'LOST' : 'FOUND'),
          eq(items.category, item.category),
          inArray(items.status, ['REGISTERED', 'MATCHED']),
        ),
      )
      .limit(500);
  }
  async insertHistory(values: typeof itemHistory.$inferInsert): Promise<void> {
    await this.x.insert(itemHistory).values(values);
  }
  historyOf(scope: TenantScope, itemId: string) {
    return this.x
      .select()
      .from(itemHistory)
      .where(tenantWhere(itemHistory, scope, eq(itemHistory.itemId, itemId)))
      .orderBy(asc(itemHistory.id));
  }

  // ---- AI metadata ----
  async putAiMetadata(values: typeof aiMetadata.$inferInsert): Promise<void> {
    await this.x
      .insert(aiMetadata)
      .values(values)
      .onConflictDoUpdate({
        target: aiMetadata.itemId,
        set: {
          objectType: values.objectType,
          colours: values.colours,
          brand: values.brand,
          keywords: values.keywords,
          modelCallId: values.modelCallId,
          updatedAt: new Date(),
        },
      });
  }
  async aiMetadataOf(scope: TenantScope, itemIds: readonly string[]) {
    const rows = itemIds.length
      ? await this.x
          .select()
          .from(aiMetadata)
          .where(tenantWhere(aiMetadata, scope, inArray(aiMetadata.itemId, [...itemIds])))
      : [];
    return new Map<string, AiMetadataRow>(rows.map((r) => [r.itemId, r]));
  }

  // ---- matches ----
  async insertMatch(values: typeof matchCandidates.$inferInsert): Promise<MatchRow | undefined> {
    const [row] = await this.x
      .insert(matchCandidates)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  matchesOf(scope: TenantScope, itemId: string): Promise<MatchRow[]> {
    return this.x
      .select()
      .from(matchCandidates)
      .where(
        tenantWhere(
          matchCandidates,
          scope,
          or(eq(matchCandidates.foundItemId, itemId), eq(matchCandidates.lostItemId, itemId))!,
        ),
      )
      .orderBy(desc(matchCandidates.score));
  }
  proposedMatches(scope: PropertyScope): Promise<MatchRow[]> {
    return this.x
      .select()
      .from(matchCandidates)
      .where(propertyWhere(matchCandidates, scope, eq(matchCandidates.status, 'PROPOSED')))
      .orderBy(desc(matchCandidates.score))
      .limit(200);
  }
  async matchForUpdate(scope: TenantScope, id: string): Promise<MatchRow | undefined> {
    const [row] = await this.x
      .select()
      .from(matchCandidates)
      .where(tenantWhere(matchCandidates, scope, eq(matchCandidates.id, id)))
      .for('update');
    return row;
  }
  async decideMatch(
    scope: TenantScope,
    id: string,
    patch: Pick<MatchRow, 'status' | 'decidedByType' | 'decidedById' | 'decidedAt'>,
  ): Promise<MatchRow> {
    const [row] = await this.x
      .update(matchCandidates)
      .set({ ...patch, updatedAt: new Date(), version: sql`${matchCandidates.version} + 1` })
      .where(tenantWhere(matchCandidates, scope, eq(matchCandidates.id, id)))
      .returning();
    return row!;
  }
  /** Other proposals involving either item are rejected once a match is confirmed. */
  async rejectOtherProposals(
    scope: TenantScope,
    keep: string,
    itemIds: readonly string[],
    by: Pick<MatchRow, 'decidedByType' | 'decidedById'>,
  ): Promise<number> {
    const rows = await this.x
      .update(matchCandidates)
      .set({
        status: 'REJECTED',
        ...by,
        decidedAt: new Date(),
        updatedAt: new Date(),
        version: sql`${matchCandidates.version} + 1`,
      })
      .where(
        tenantWhere(
          matchCandidates,
          scope,
          and(
            eq(matchCandidates.status, 'PROPOSED'),
            sql`${matchCandidates.id} <> ${keep}`,
            or(
              inArray(matchCandidates.foundItemId, [...itemIds]),
              inArray(matchCandidates.lostItemId, [...itemIds]),
            ),
          )!,
        ),
      )
      .returning({ id: matchCandidates.id });
    return rows.length;
  }

  // ---- claims ----
  async insertClaim(values: typeof claims.$inferInsert): Promise<ClaimRow> {
    const [row] = await this.x.insert(claims).values(values).returning();
    return row!;
  }
  async claimOf(scope: TenantScope, itemId: string): Promise<ClaimRow | undefined> {
    const [row] = await this.x
      .select()
      .from(claims)
      .where(tenantWhere(claims, scope, eq(claims.itemId, itemId)));
    return row;
  }
}
