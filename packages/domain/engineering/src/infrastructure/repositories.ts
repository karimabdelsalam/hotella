import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
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
  type AssetDocumentRow,
  assetDocuments,
  type AssetModelRow,
  assetModels,
  type AssetRow,
  assets,
  type AssetTypeRow,
  assetTypes,
  assetTypeTranslations,
  type FailureCodeRow,
  failureCodes,
  failureCodeTranslations,
  meterReadings,
  type MeterRow,
  meters,
  type PmPlanRow,
  pmPlans,
  pmProcedures,
  type PmProcedureVersionRow,
  pmProcedureVersions,
  type RoomRestrictionRow,
  roomRestrictions,
  partMovements,
  type PartRow,
  parts,
  type WarrantyCaseRow,
  warrantyCases,
  type WorkOrderRow,
  workOrders,
} from './schema';

export interface Translation {
  readonly locale: string;
  readonly name: string;
}

@Injectable()
export class EngineeringRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- asset types ----
  async insertAssetType(values: typeof assetTypes.$inferInsert): Promise<AssetTypeRow | undefined> {
    const [row] = await this.x.insert(assetTypes).values(values).onConflictDoNothing().returning();
    return row;
  }
  async assetType(scope: TenantScope, id: string): Promise<AssetTypeRow | undefined> {
    const [row] = await this.x
      .select()
      .from(assetTypes)
      .where(tenantWhere(assetTypes, scope, eq(assetTypes.id, id)));
    return row;
  }
  async assetTypeForUpdate(scope: TenantScope, id: string): Promise<AssetTypeRow | undefined> {
    const [row] = await this.x
      .select()
      .from(assetTypes)
      .where(tenantWhere(assetTypes, scope, eq(assetTypes.id, id)))
      .for('update');
    return row;
  }
  async updateAssetType(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<AssetTypeRow, 'properties' | 'active'>>,
  ): Promise<AssetTypeRow> {
    const [row] = await this.x
      .update(assetTypes)
      .set({ ...patch, version: sql`${assetTypes.version} + 1` })
      .where(tenantWhere(assetTypes, scope, eq(assetTypes.id, id)))
      .returning();
    return row!;
  }
  assetTypes(scope: TenantScope): Promise<AssetTypeRow[]> {
    return this.x
      .select()
      .from(assetTypes)
      .where(tenantWhere(assetTypes, scope))
      .orderBy(asc(assetTypes.code));
  }
  async putAssetTypeTranslations(id: string, translations: readonly Translation[]): Promise<void> {
    for (const t of translations)
      await this.x
        .insert(assetTypeTranslations)
        .values({ entityId: id, locale: t.locale, name: t.name })
        .onConflictDoUpdate({
          target: [assetTypeTranslations.entityId, assetTypeTranslations.locale],
          set: { name: t.name },
        });
  }
  async assetTypeTranslations(ids: readonly string[]): Promise<Map<string, Translation[]>> {
    const rows = ids.length
      ? await this.x
          .select()
          .from(assetTypeTranslations)
          .where(inArray(assetTypeTranslations.entityId, [...ids]))
          .orderBy(asc(assetTypeTranslations.locale))
      : [];
    return group(rows);
  }

  // ---- models ----
  async insertAssetModel(
    values: typeof assetModels.$inferInsert,
  ): Promise<AssetModelRow | undefined> {
    const [row] = await this.x.insert(assetModels).values(values).onConflictDoNothing().returning();
    return row;
  }
  async assetModel(scope: TenantScope, id: string): Promise<AssetModelRow | undefined> {
    const [row] = await this.x
      .select()
      .from(assetModels)
      .where(tenantWhere(assetModels, scope, eq(assetModels.id, id)));
    return row;
  }
  assetModels(scope: TenantScope, assetTypeId?: string): Promise<AssetModelRow[]> {
    return this.x
      .select()
      .from(assetModels)
      .where(
        tenantWhere(
          assetModels,
          scope,
          ...(assetTypeId ? [eq(assetModels.assetTypeId, assetTypeId)] : []),
        ),
      )
      .orderBy(asc(assetModels.manufacturer), asc(assetModels.modelCode));
  }

  // ---- assets ----
  async insertAsset(values: typeof assets.$inferInsert): Promise<AssetRow | undefined> {
    const [row] = await this.x.insert(assets).values(values).onConflictDoNothing().returning();
    return row;
  }
  async asset(scope: TenantScope, id: string): Promise<AssetRow | undefined> {
    const [row] = await this.x
      .select()
      .from(assets)
      .where(tenantWhere(assets, scope, eq(assets.id, id)));
    return row;
  }
  async assetForUpdate(scope: TenantScope, id: string): Promise<AssetRow | undefined> {
    const [row] = await this.x
      .select()
      .from(assets)
      .where(tenantWhere(assets, scope, eq(assets.id, id)))
      .for('update');
    return row;
  }
  async updateAsset(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<
        AssetRow,
        | 'parentAssetId'
        | 'assetModelId'
        | 'locationId'
        | 'name'
        | 'serialNumber'
        | 'status'
        | 'criticality'
        | 'installedAt'
        | 'warrantyUntil'
        | 'properties'
      >
    >,
  ): Promise<AssetRow> {
    const [row] = await this.x
      .update(assets)
      .set({ ...patch, version: sql`${assets.version} + 1` })
      .where(tenantWhere(assets, scope, eq(assets.id, id)))
      .returning();
    return row!;
  }
  assetsOf(
    scope: PropertyScope,
    filter: {
      locationIds?: readonly string[];
      assetTypeId?: string;
      parentAssetId?: string | null;
    },
  ): Promise<AssetRow[]> {
    return this.x
      .select()
      .from(assets)
      .where(
        propertyWhere(
          assets,
          scope,
          ...(filter.locationIds ? [inArray(assets.locationId, [...filter.locationIds])] : []),
          ...(filter.assetTypeId ? [eq(assets.assetTypeId, filter.assetTypeId)] : []),
          ...(filter.parentAssetId === null
            ? [isNull(assets.parentAssetId)]
            : filter.parentAssetId
              ? [eq(assets.parentAssetId, filter.parentAssetId)]
              : []),
        ),
      )
      .orderBy(asc(assets.assetNumber));
  }
  /** The asset's ancestors, nearest first (cycle-safe: depth-limited). */
  async ancestors(scope: TenantScope, id: string): Promise<string[]> {
    const rows = await this.x.execute(sql`
      with recursive up(id, parent, depth) as (
        select id, parent_asset_id, 0 from eng.assets where id = ${id} and tenant_id = ${scope.tenantId}
        union all
        select a.id, a.parent_asset_id, up.depth + 1 from eng.assets a join up on a.id = up.parent
        where up.depth < 50 and a.tenant_id = ${scope.tenantId}
      )
      select id from up where depth > 0 order by depth`);
    return (rows.rows as Array<{ id: string }>).map((r) => r.id);
  }

  // ---- documents ----
  async insertDocument(
    values: typeof assetDocuments.$inferInsert,
  ): Promise<AssetDocumentRow | undefined> {
    const [row] = await this.x
      .insert(assetDocuments)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  documentsFor(scope: TenantScope, asset: AssetRow): Promise<AssetDocumentRow[]> {
    return this.x
      .select()
      .from(assetDocuments)
      .where(
        tenantWhere(
          assetDocuments,
          scope,
          or(
            eq(assetDocuments.assetId, asset.id),
            ...(asset.assetModelId ? [eq(assetDocuments.assetModelId, asset.assetModelId)] : []),
          )!,
        ),
      )
      .orderBy(asc(assetDocuments.id));
  }

  // ---- failure taxonomy ----
  async insertFailureCode(
    values: typeof failureCodes.$inferInsert,
  ): Promise<FailureCodeRow | undefined> {
    const [row] = await this.x
      .insert(failureCodes)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  failureCodes(scope: TenantScope, kind?: FailureCodeRow['kind']): Promise<FailureCodeRow[]> {
    return this.x
      .select()
      .from(failureCodes)
      .where(tenantWhere(failureCodes, scope, ...(kind ? [eq(failureCodes.kind, kind)] : [])))
      .orderBy(asc(failureCodes.kind), asc(failureCodes.code));
  }
  async failureCode(
    scope: TenantScope,
    kind: FailureCodeRow['kind'],
    code: string,
  ): Promise<FailureCodeRow | undefined> {
    const [row] = await this.x
      .select()
      .from(failureCodes)
      .where(
        tenantWhere(
          failureCodes,
          scope,
          and(eq(failureCodes.kind, kind), eq(failureCodes.code, code))!,
        ),
      );
    return row;
  }
  async putFailureCodeTranslations(
    id: string,
    translations: readonly Translation[],
  ): Promise<void> {
    for (const t of translations)
      await this.x
        .insert(failureCodeTranslations)
        .values({ entityId: id, locale: t.locale, name: t.name })
        .onConflictDoUpdate({
          target: [failureCodeTranslations.entityId, failureCodeTranslations.locale],
          set: { name: t.name },
        });
  }
  async failureCodeTranslations(ids: readonly string[]): Promise<Map<string, Translation[]>> {
    const rows = ids.length
      ? await this.x
          .select()
          .from(failureCodeTranslations)
          .where(inArray(failureCodeTranslations.entityId, [...ids]))
          .orderBy(asc(failureCodeTranslations.locale))
      : [];
    return group(rows);
  }

  // ---- work orders ----
  /** The next work order number of the property (serialized per property inside the transaction). */
  async nextWorkOrderNumber(scope: PropertyScope): Promise<number> {
    await this.x.execute(
      sql`select pg_advisory_xact_lock(hashtext(${'eng.wo.' + scope.propertyId}))`,
    );
    const { rows } = await this.x.execute(
      sql`select coalesce(max(number), 0) + 1 as n from eng.work_orders where property_id = ${scope.propertyId}`,
    );
    return Number((rows[0] as { n: number | string }).n);
  }
  async insertWorkOrder(values: typeof workOrders.$inferInsert): Promise<WorkOrderRow | undefined> {
    const [row] = await this.x.insert(workOrders).values(values).onConflictDoNothing().returning();
    return row;
  }
  async workOrder(scope: TenantScope, id: string): Promise<WorkOrderRow | undefined> {
    const [row] = await this.x
      .select()
      .from(workOrders)
      .where(tenantWhere(workOrders, scope, eq(workOrders.id, id)));
    return row;
  }
  async workOrderForUpdate(scope: TenantScope, id: string): Promise<WorkOrderRow | undefined> {
    const [row] = await this.x
      .select()
      .from(workOrders)
      .where(tenantWhere(workOrders, scope, eq(workOrders.id, id)))
      .for('update');
    return row;
  }
  async workOrderOfWorkItem(
    scope: TenantScope,
    workItemId: string,
  ): Promise<WorkOrderRow | undefined> {
    const [row] = await this.x
      .select()
      .from(workOrders)
      .where(tenantWhere(workOrders, scope, eq(workOrders.workItemId, workItemId)))
      .for('update');
    return row;
  }
  async updateWorkOrder(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<
        WorkOrderRow,
        | 'symptomCode'
        | 'diagnosis'
        | 'failureModeCode'
        | 'causeCode'
        | 'resolutionCode'
        | 'downtimeStartedAt'
        | 'downtimeEndedAt'
        | 'status'
        | 'completedAt'
        | 'assetId'
      >
    >,
  ): Promise<WorkOrderRow> {
    const [row] = await this.x
      .update(workOrders)
      .set({ ...patch, version: sql`${workOrders.version} + 1` })
      .where(tenantWhere(workOrders, scope, eq(workOrders.id, id)))
      .returning();
    return row!;
  }
  workOrdersOf(
    scope: PropertyScope,
    filter: { statuses?: readonly WorkOrderRow['status'][]; assetId?: string },
  ): Promise<WorkOrderRow[]> {
    return this.x
      .select()
      .from(workOrders)
      .where(
        propertyWhere(
          workOrders,
          scope,
          ...(filter.statuses ? [inArray(workOrders.status, [...filter.statuses])] : []),
          ...(filter.assetId ? [eq(workOrders.assetId, filter.assetId)] : []),
        ),
      )
      .orderBy(sql`${workOrders.number} desc`)
      .limit(200);
  }

  // ---- parts ----
  async insertPart(values: typeof parts.$inferInsert): Promise<PartRow | undefined> {
    const [row] = await this.x.insert(parts).values(values).onConflictDoNothing().returning();
    return row;
  }
  async partForUpdate(scope: PropertyScope, id: string): Promise<PartRow | undefined> {
    const [row] = await this.x
      .select()
      .from(parts)
      .where(propertyWhere(parts, scope, eq(parts.id, id)))
      .for('update');
    return row;
  }
  partsOf(scope: PropertyScope): Promise<PartRow[]> {
    return this.x
      .select()
      .from(parts)
      .where(propertyWhere(parts, scope))
      .orderBy(asc(parts.partNumber));
  }
  async moveStock(
    scope: PropertyScope,
    partId: string,
    delta: number,
    movement: Omit<typeof partMovements.$inferInsert, 'tenantId' | 'propertyId' | 'partId'>,
  ): Promise<PartRow> {
    const [row] = await this.x
      .update(parts)
      .set({ onHand: sql`${parts.onHand} + ${delta}`, version: sql`${parts.version} + 1` })
      .where(propertyWhere(parts, scope, eq(parts.id, partId)))
      .returning();
    await this.x
      .insert(partMovements)
      .values({ ...movement, tenantId: scope.tenantId, propertyId: scope.propertyId, partId });
    return row!;
  }
  usagesOf(scope: TenantScope, workOrderId: string) {
    return this.x
      .select({
        partId: partMovements.partId,
        partNumber: parts.partNumber,
        name: parts.name,
        unit: parts.unit,
        quantity: partMovements.quantity,
        occurredAt: partMovements.occurredAt,
      })
      .from(partMovements)
      .innerJoin(parts, eq(parts.id, partMovements.partId))
      .where(tenantWhere(partMovements, scope, eq(partMovements.workOrderId, workOrderId)))
      .orderBy(asc(partMovements.occurredAt));
  }

  // ---- warranty ----
  async insertWarrantyCase(
    values: typeof warrantyCases.$inferInsert,
  ): Promise<WarrantyCaseRow | undefined> {
    const [row] = await this.x
      .insert(warrantyCases)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  async warrantyCaseForUpdate(
    scope: PropertyScope,
    id: string,
  ): Promise<WarrantyCaseRow | undefined> {
    const [row] = await this.x
      .select()
      .from(warrantyCases)
      .where(propertyWhere(warrantyCases, scope, eq(warrantyCases.id, id)))
      .for('update');
    return row;
  }
  async updateWarrantyCase(
    scope: PropertyScope,
    id: string,
    patch: Pick<WarrantyCaseRow, 'status' | 'note'>,
  ): Promise<WarrantyCaseRow> {
    const [row] = await this.x
      .update(warrantyCases)
      .set({ ...patch, version: sql`${warrantyCases.version} + 1` })
      .where(propertyWhere(warrantyCases, scope, eq(warrantyCases.id, id)))
      .returning();
    return row!;
  }
  warrantyCasesOf(scope: PropertyScope, statuses?: readonly WarrantyCaseRow['status'][]) {
    return this.x
      .select()
      .from(warrantyCases)
      .where(
        propertyWhere(
          warrantyCases,
          scope,
          ...(statuses ? [inArray(warrantyCases.status, [...statuses])] : []),
        ),
      )
      .orderBy(asc(warrantyCases.createdAt));
  }

  // ---- meters ----
  async insertMeter(values: typeof meters.$inferInsert): Promise<MeterRow | undefined> {
    const [row] = await this.x.insert(meters).values(values).onConflictDoNothing().returning();
    return row;
  }
  async meterForUpdate(scope: PropertyScope, id: string): Promise<MeterRow | undefined> {
    const [row] = await this.x
      .select()
      .from(meters)
      .where(propertyWhere(meters, scope, eq(meters.id, id)))
      .for('update');
    return row;
  }
  async meter(scope: TenantScope, id: string): Promise<MeterRow | undefined> {
    const [row] = await this.x
      .select()
      .from(meters)
      .where(tenantWhere(meters, scope, eq(meters.id, id)));
    return row;
  }
  metersOf(scope: PropertyScope, assetId?: string): Promise<MeterRow[]> {
    return this.x
      .select()
      .from(meters)
      .where(propertyWhere(meters, scope, ...(assetId ? [eq(meters.assetId, assetId)] : [])))
      .orderBy(asc(meters.id));
  }
  async recordReading(
    scope: PropertyScope,
    meterId: string,
    reading: Omit<typeof meterReadings.$inferInsert, 'tenantId' | 'propertyId' | 'meterId'>,
  ): Promise<MeterRow> {
    await this.x
      .insert(meterReadings)
      .values({ ...reading, tenantId: scope.tenantId, propertyId: scope.propertyId, meterId });
    const [row] = await this.x
      .update(meters)
      .set({ lastValue: reading.value, lastReadAt: reading.readAt })
      .where(propertyWhere(meters, scope, eq(meters.id, meterId)))
      .returning();
    return row!;
  }

  // ---- procedures ----
  async insertProcedure(values: typeof pmProcedures.$inferInsert) {
    const [row] = await this.x
      .insert(pmProcedures)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  async procedure(scope: TenantScope, id: string) {
    const [row] = await this.x
      .select()
      .from(pmProcedures)
      .where(tenantWhere(pmProcedures, scope, eq(pmProcedures.id, id)));
    return row;
  }
  procedures(scope: TenantScope) {
    return this.x
      .select()
      .from(pmProcedures)
      .where(tenantWhere(pmProcedures, scope))
      .orderBy(asc(pmProcedures.code));
  }
  async insertProcedureVersion(
    values: typeof pmProcedureVersions.$inferInsert,
  ): Promise<PmProcedureVersionRow> {
    const [row] = await this.x.insert(pmProcedureVersions).values(values).returning();
    return row!;
  }
  procedureVersions(scope: TenantScope, procedureId: string): Promise<PmProcedureVersionRow[]> {
    return this.x
      .select()
      .from(pmProcedureVersions)
      .where(
        tenantWhere(pmProcedureVersions, scope, eq(pmProcedureVersions.procedureId, procedureId)),
      )
      .orderBy(asc(pmProcedureVersions.versionNo));
  }
  async procedureVersionForUpdate(
    scope: TenantScope,
    id: string,
  ): Promise<PmProcedureVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(pmProcedureVersions)
      .where(tenantWhere(pmProcedureVersions, scope, eq(pmProcedureVersions.id, id)))
      .for('update');
    return row;
  }
  async updateProcedureVersion(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<PmProcedureVersionRow, 'steps' | 'estimatedMinutes' | 'status' | 'publishedAt'>
    >,
  ): Promise<PmProcedureVersionRow> {
    const [row] = await this.x
      .update(pmProcedureVersions)
      .set(patch)
      .where(tenantWhere(pmProcedureVersions, scope, eq(pmProcedureVersions.id, id)))
      .returning();
    return row!;
  }
  /** The latest published version of a procedure (what new preventive work follows). */
  async publishedVersion(
    scope: TenantScope,
    procedureId: string,
  ): Promise<PmProcedureVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(pmProcedureVersions)
      .where(
        tenantWhere(
          pmProcedureVersions,
          scope,
          eq(pmProcedureVersions.procedureId, procedureId),
          eq(pmProcedureVersions.status, 'PUBLISHED'),
        ),
      )
      .orderBy(sql`${pmProcedureVersions.versionNo} desc`)
      .limit(1);
    return row;
  }
  async procedureVersion(
    scope: TenantScope,
    id: string,
  ): Promise<PmProcedureVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(pmProcedureVersions)
      .where(tenantWhere(pmProcedureVersions, scope, eq(pmProcedureVersions.id, id)));
    return row;
  }

  // ---- plans ----
  async insertPlan(values: typeof pmPlans.$inferInsert): Promise<PmPlanRow> {
    const [row] = await this.x.insert(pmPlans).values(values).returning();
    return row!;
  }
  async planForUpdate(scope: TenantScope, id: string): Promise<PmPlanRow | undefined> {
    const [row] = await this.x
      .select()
      .from(pmPlans)
      .where(tenantWhere(pmPlans, scope, eq(pmPlans.id, id)))
      .for('update');
    return row;
  }
  async updatePlan(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<
        PmPlanRow,
        'lastDoneOn' | 'lastDoneValue' | 'openWorkOrderId' | 'active' | 'leadDays' | 'trigger'
      >
    >,
  ): Promise<PmPlanRow> {
    const [row] = await this.x
      .update(pmPlans)
      .set({ ...patch, version: sql`${pmPlans.version} + 1` })
      .where(tenantWhere(pmPlans, scope, eq(pmPlans.id, id)))
      .returning();
    return row!;
  }
  plansOf(scope: PropertyScope): Promise<PmPlanRow[]> {
    return this.x
      .select()
      .from(pmPlans)
      .where(propertyWhere(pmPlans, scope))
      .orderBy(asc(pmPlans.id));
  }
  /** Active plans without open work, across tenants (the worker's due sweep). */
  plansToCheck(): Promise<PmPlanRow[]> {
    return this.x
      .select()
      .from(pmPlans)
      .where(and(eq(pmPlans.active, true), isNull(pmPlans.openWorkOrderId)))
      .orderBy(asc(pmPlans.tenantId), asc(pmPlans.propertyId), asc(pmPlans.id));
  }

  // ---- room restrictions ----
  async insertRestriction(
    values: typeof roomRestrictions.$inferInsert,
  ): Promise<RoomRestrictionRow | undefined> {
    const [row] = await this.x
      .insert(roomRestrictions)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  async restrictionForUpdate(
    scope: PropertyScope,
    id: string,
  ): Promise<RoomRestrictionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(roomRestrictions)
      .where(propertyWhere(roomRestrictions, scope, eq(roomRestrictions.id, id)))
      .for('update');
    return row;
  }
  async updateRestriction(
    scope: PropertyScope,
    id: string,
    patch: Partial<
      Pick<
        RoomRestrictionRow,
        'releasedAt' | 'releasedByType' | 'releasedById' | 'pmsSync' | 'endsAt'
      >
    >,
  ): Promise<RoomRestrictionRow> {
    const [row] = await this.x
      .update(roomRestrictions)
      .set({ ...patch, version: sql`${roomRestrictions.version} + 1` })
      .where(propertyWhere(roomRestrictions, scope, eq(roomRestrictions.id, id)))
      .returning();
    return row!;
  }
  restrictionsOf(scope: PropertyScope, openOnly: boolean): Promise<RoomRestrictionRow[]> {
    return this.x
      .select()
      .from(roomRestrictions)
      .where(
        propertyWhere(
          roomRestrictions,
          scope,
          ...(openOnly ? [isNull(roomRestrictions.releasedAt)] : []),
        ),
      )
      .orderBy(sql`${roomRestrictions.startsAt} desc`);
  }
  async openRestriction(
    scope: PropertyScope,
    roomId: string,
  ): Promise<RoomRestrictionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(roomRestrictions)
      .where(
        propertyWhere(
          roomRestrictions,
          scope,
          eq(roomRestrictions.roomId, roomId),
          isNull(roomRestrictions.releasedAt),
        ),
      );
    return row;
  }
}

function group(rows: ReadonlyArray<{ entityId: string; locale: string; name: string }>) {
  const out = new Map<string, Translation[]>();
  for (const r of rows)
    out.set(r.entityId, [...(out.get(r.entityId) ?? []), { locale: r.locale, name: r.name }]);
  return out;
}
