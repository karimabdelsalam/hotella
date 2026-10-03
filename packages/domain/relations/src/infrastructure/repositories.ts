import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  type CandidateRow,
  candidates,
  categories,
  type CategoryRow,
  categoryTranslations,
  type ComplaintRow,
  complaints,
  evidence,
  type EvidenceRow,
  links,
  recoveryActions,
  type RecoveryRow,
  statusHistory,
} from './schema';

@Injectable()
export class RelationsRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- categories ----
  async insertCategory(values: typeof categories.$inferInsert): Promise<CategoryRow | undefined> {
    const [row] = await this.x.insert(categories).values(values).onConflictDoNothing().returning();
    return row;
  }
  categoriesOf(scope: TenantScope): Promise<CategoryRow[]> {
    return this.x
      .select()
      .from(categories)
      .where(tenantWhere(categories, scope))
      .orderBy(asc(categories.code));
  }
  async category(scope: TenantScope, id: string): Promise<CategoryRow | undefined> {
    const [row] = await this.x
      .select()
      .from(categories)
      .where(tenantWhere(categories, scope, eq(categories.id, id)));
    return row;
  }
  async categoryByCode(scope: TenantScope, code: string): Promise<CategoryRow | undefined> {
    const [row] = await this.x
      .select()
      .from(categories)
      .where(tenantWhere(categories, scope, eq(categories.code, code)));
    return row;
  }
  async putCategoryNames(id: string, names: ReadonlyArray<{ locale: string; name: string }>) {
    for (const n of names)
      await this.x
        .insert(categoryTranslations)
        .values({ entityId: id, locale: n.locale, name: n.name })
        .onConflictDoUpdate({
          target: [categoryTranslations.entityId, categoryTranslations.locale],
          set: { name: n.name },
        });
  }
  async categoryNames(ids: readonly string[]) {
    const rows = ids.length
      ? await this.x
          .select()
          .from(categoryTranslations)
          .where(inArray(categoryTranslations.entityId, [...ids]))
      : [];
    const out = new Map<string, Array<{ locale: string; name: string }>>();
    for (const r of rows)
      out.set(r.entityId, [...(out.get(r.entityId) ?? []), { locale: r.locale, name: r.name }]);
    return out;
  }

  // ---- complaints ----
  async nextNumber(scope: PropertyScope): Promise<number> {
    await this.x.execute(
      sql`select pg_advisory_xact_lock(hashtext(${'relations.no.' + scope.propertyId}))`,
    );
    const { rows } = await this.x.execute(
      sql`select coalesce(max(number), 0) + 1 as n from relations.complaints where property_id = ${scope.propertyId}`,
    );
    return Number((rows[0] as { n: number | string }).n);
  }
  async insertComplaint(values: typeof complaints.$inferInsert): Promise<ComplaintRow> {
    const [row] = await this.x.insert(complaints).values(values).returning();
    return row!;
  }
  async complaint(scope: TenantScope, id: string): Promise<ComplaintRow | undefined> {
    const [row] = await this.x
      .select()
      .from(complaints)
      .where(tenantWhere(complaints, scope, eq(complaints.id, id)));
    return row;
  }
  async complaintForUpdate(scope: TenantScope, id: string): Promise<ComplaintRow | undefined> {
    const [row] = await this.x
      .select()
      .from(complaints)
      .where(tenantWhere(complaints, scope, eq(complaints.id, id)))
      .for('update');
    return row;
  }
  async updateComplaint(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<ComplaintRow, 'status' | 'resolvedAt' | 'closedAt' | 'severity'>>,
  ): Promise<ComplaintRow> {
    const [row] = await this.x
      .update(complaints)
      .set({ ...patch, updatedAt: new Date(), version: sql`${complaints.version} + 1` })
      .where(tenantWhere(complaints, scope, eq(complaints.id, id)))
      .returning();
    return row!;
  }
  complaintsOf(
    scope: PropertyScope,
    filter: { statuses?: readonly ComplaintRow['status'][]; stayId?: string },
  ): Promise<ComplaintRow[]> {
    return this.x
      .select()
      .from(complaints)
      .where(
        propertyWhere(
          complaints,
          scope,
          ...(filter.statuses ? [inArray(complaints.status, [...filter.statuses])] : []),
          ...(filter.stayId ? [eq(complaints.stayId, filter.stayId)] : []),
        ),
      )
      .orderBy(desc(complaints.number))
      .limit(200);
  }
  async insertHistory(values: typeof statusHistory.$inferInsert): Promise<void> {
    await this.x.insert(statusHistory).values(values);
  }
  historyOf(scope: TenantScope, complaintId: string) {
    return this.x
      .select()
      .from(statusHistory)
      .where(tenantWhere(statusHistory, scope, eq(statusHistory.complaintId, complaintId)))
      .orderBy(asc(statusHistory.id));
  }
  async insertLink(values: typeof links.$inferInsert): Promise<void> {
    await this.x.insert(links).values(values).onConflictDoNothing();
  }
  linksOf(scope: TenantScope, complaintId: string) {
    return this.x
      .select()
      .from(links)
      .where(tenantWhere(links, scope, eq(links.complaintId, complaintId)))
      .orderBy(asc(links.id));
  }
  async insertEvidence(values: typeof evidence.$inferInsert): Promise<EvidenceRow> {
    const [row] = await this.x.insert(evidence).values(values).returning();
    return row!;
  }
  evidenceOf(scope: TenantScope, complaintId: string): Promise<EvidenceRow[]> {
    return this.x
      .select()
      .from(evidence)
      .where(tenantWhere(evidence, scope, eq(evidence.complaintId, complaintId)))
      .orderBy(asc(evidence.id));
  }

  // ---- candidates ----
  /** Undefined when a pending candidate of the same stay and category already exists. */
  async insertCandidate(values: typeof candidates.$inferInsert): Promise<CandidateRow | undefined> {
    const [row] = await this.x.insert(candidates).values(values).onConflictDoNothing().returning();
    return row;
  }
  async pendingCandidateFor(
    scope: PropertyScope,
    stayId: string,
    categoryCode: string,
  ): Promise<CandidateRow | undefined> {
    const [row] = await this.x
      .select()
      .from(candidates)
      .where(
        propertyWhere(
          candidates,
          scope,
          and(
            eq(candidates.stayId, stayId),
            eq(candidates.categoryCode, categoryCode),
            eq(candidates.status, 'PENDING'),
          )!,
        ),
      );
    return row;
  }
  async candidateForUpdate(scope: TenantScope, id: string): Promise<CandidateRow | undefined> {
    const [row] = await this.x
      .select()
      .from(candidates)
      .where(tenantWhere(candidates, scope, eq(candidates.id, id)))
      .for('update');
    return row;
  }
  async updateCandidate(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<CandidateRow, 'status' | 'decidedByType' | 'decidedById' | 'decidedAt' | 'complaintId'>
    >,
  ): Promise<CandidateRow> {
    const [row] = await this.x
      .update(candidates)
      .set({ ...patch, updatedAt: new Date(), version: sql`${candidates.version} + 1` })
      .where(tenantWhere(candidates, scope, eq(candidates.id, id)))
      .returning();
    return row!;
  }
  candidatesOf(scope: PropertyScope, status: CandidateRow['status']): Promise<CandidateRow[]> {
    return this.x
      .select()
      .from(candidates)
      .where(propertyWhere(candidates, scope, eq(candidates.status, status)))
      .orderBy(desc(candidates.id))
      .limit(200);
  }

  // ---- recovery ----
  async insertRecovery(values: typeof recoveryActions.$inferInsert): Promise<RecoveryRow> {
    const [row] = await this.x.insert(recoveryActions).values(values).returning();
    return row!;
  }
  recoveryOf(scope: TenantScope, complaintId: string): Promise<RecoveryRow[]> {
    return this.x
      .select()
      .from(recoveryActions)
      .where(tenantWhere(recoveryActions, scope, eq(recoveryActions.complaintId, complaintId)))
      .orderBy(asc(recoveryActions.id));
  }
  async recoveryOfApproval(
    scope: TenantScope,
    approvalId: string,
  ): Promise<RecoveryRow | undefined> {
    const [row] = await this.x
      .select()
      .from(recoveryActions)
      .where(tenantWhere(recoveryActions, scope, eq(recoveryActions.approvalId, approvalId)))
      .for('update');
    return row;
  }
  async updateRecovery(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<RecoveryRow, 'status' | 'approvalId' | 'decidedAt'>>,
  ): Promise<RecoveryRow> {
    const [row] = await this.x
      .update(recoveryActions)
      .set({ ...patch, updatedAt: new Date(), version: sql`${recoveryActions.version} + 1` })
      .where(tenantWhere(recoveryActions, scope, eq(recoveryActions.id, id)))
      .returning();
    return row!;
  }
}
