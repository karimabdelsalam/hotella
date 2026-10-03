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
}

function group(rows: ReadonlyArray<{ entityId: string; locale: string; name: string }>) {
  const out = new Map<string, Translation[]>();
  for (const r of rows)
    out.set(r.entityId, [...(out.get(r.entityId) ?? []), { locale: r.locale, name: r.name }]);
  return out;
}
