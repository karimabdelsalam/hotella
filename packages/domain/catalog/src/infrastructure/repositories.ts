import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  type CategoryRow,
  type CategoryTranslationRow,
  type DefinitionRow,
  serviceCategories,
  serviceCategoryTranslations,
  serviceDefinitions,
  serviceVersions,
  serviceVersionTranslations,
  type VersionRow,
  type VersionTranslationRow,
} from './schema';

/** Tenant-wide rows (null property) and, when a property is given, that property's rows. */
function visibleAt(
  column: typeof serviceCategories.propertyId | typeof serviceDefinitions.propertyId,
  propertyId: string | null,
) {
  return propertyId ? or(isNull(column), eq(column, propertyId)) : isNull(column);
}

export interface TranslationInput {
  readonly locale: string;
  readonly name: string;
  readonly description?: string | null;
}
export interface VersionTranslationInput extends TranslationInput {
  readonly shortDescription?: string | null;
  readonly guestPromptHints?: string | null;
  readonly fieldLabels?: Record<string, unknown>;
}

/** Repositories never accept a query on tenant data without a tenant scope (CLAUDE.md rule 1). */
@Injectable()
export class CatalogRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- categories ----
  async insertCategory(values: typeof serviceCategories.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.x.insert(serviceCategories).values(values).returning();
    return row!;
  }
  category(scope: TenantScope, id: string): Promise<CategoryRow | undefined> {
    return this.x
      .select()
      .from(serviceCategories)
      .where(tenantWhere(serviceCategories, scope, eq(serviceCategories.id, id)))
      .then((r) => r[0]);
  }
  /** Exactly the rows of one level: tenant-wide (`propertyId` null) or one property's. */
  categoryByCode(
    scope: TenantScope,
    propertyId: string | null,
    code: string,
  ): Promise<CategoryRow | undefined> {
    return this.x
      .select()
      .from(serviceCategories)
      .where(
        tenantWhere(
          serviceCategories,
          scope,
          eq(serviceCategories.code, code),
          propertyId
            ? eq(serviceCategories.propertyId, propertyId)
            : isNull(serviceCategories.propertyId),
        ),
      )
      .then((r) => r[0]);
  }
  categoriesAt(scope: TenantScope, propertyId: string | null): Promise<CategoryRow[]> {
    return this.x
      .select()
      .from(serviceCategories)
      .where(
        tenantWhere(serviceCategories, scope, visibleAt(serviceCategories.propertyId, propertyId)),
      )
      .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.code));
  }
  async updateCategory(
    scope: TenantScope,
    id: string,
    version: number,
    values: Partial<typeof serviceCategories.$inferInsert>,
  ): Promise<CategoryRow | undefined> {
    const [row] = await this.x
      .update(serviceCategories)
      .set({ ...values, version: sql`${serviceCategories.version} + 1` })
      .where(
        tenantWhere(
          serviceCategories,
          scope,
          eq(serviceCategories.id, id),
          eq(serviceCategories.version, version),
        ),
      )
      .returning();
    return row;
  }
  async putCategoryTranslations(categoryId: string, rows: readonly TranslationInput[]) {
    if (rows.length === 0) return;
    await this.x
      .insert(serviceCategoryTranslations)
      .values(
        rows.map((t) => ({
          entityId: categoryId,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [serviceCategoryTranslations.entityId, serviceCategoryTranslations.locale],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          updatedAt: new Date(),
        },
      });
  }
  /** Translations of categories the caller already loaded through a tenant-scoped query. */
  categoryTranslations(ids: readonly string[]): Promise<CategoryTranslationRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(serviceCategoryTranslations)
      .where(inArray(serviceCategoryTranslations.entityId, [...ids]));
  }

  // ---- definitions ----
  async insertDefinition(values: typeof serviceDefinitions.$inferInsert): Promise<DefinitionRow> {
    const [row] = await this.x.insert(serviceDefinitions).values(values).returning();
    return row!;
  }
  definition(scope: TenantScope, id: string): Promise<DefinitionRow | undefined> {
    return this.x
      .select()
      .from(serviceDefinitions)
      .where(tenantWhere(serviceDefinitions, scope, eq(serviceDefinitions.id, id)))
      .then((r) => r[0]);
  }
  definitionByCode(
    scope: TenantScope,
    propertyId: string | null,
    code: string,
  ): Promise<DefinitionRow | undefined> {
    return this.x
      .select()
      .from(serviceDefinitions)
      .where(
        tenantWhere(
          serviceDefinitions,
          scope,
          eq(serviceDefinitions.code, code),
          propertyId
            ? eq(serviceDefinitions.propertyId, propertyId)
            : isNull(serviceDefinitions.propertyId),
        ),
      )
      .then((r) => r[0]);
  }
  definitionsAt(scope: TenantScope, propertyId: string | null): Promise<DefinitionRow[]> {
    return this.x
      .select()
      .from(serviceDefinitions)
      .where(
        tenantWhere(
          serviceDefinitions,
          scope,
          visibleAt(serviceDefinitions.propertyId, propertyId),
        ),
      )
      .orderBy(asc(serviceDefinitions.sortOrder), asc(serviceDefinitions.code));
  }
  async updateDefinition(
    scope: TenantScope,
    id: string,
    version: number | null,
    values: Partial<typeof serviceDefinitions.$inferInsert>,
  ): Promise<DefinitionRow | undefined> {
    const [row] = await this.x
      .update(serviceDefinitions)
      .set({ ...values, version: sql`${serviceDefinitions.version} + 1` })
      .where(
        tenantWhere(
          serviceDefinitions,
          scope,
          eq(serviceDefinitions.id, id),
          version === null ? undefined : eq(serviceDefinitions.version, version),
        ),
      )
      .returning();
    return row;
  }

  // ---- versions ----
  async insertVersion(values: typeof serviceVersions.$inferInsert): Promise<VersionRow> {
    const [row] = await this.x.insert(serviceVersions).values(values).returning();
    return row!;
  }
  version(scope: TenantScope, id: string): Promise<VersionRow | undefined> {
    return this.x
      .select()
      .from(serviceVersions)
      .where(tenantWhere(serviceVersions, scope, eq(serviceVersions.id, id)))
      .then((r) => r[0]);
  }
  versionsByIds(scope: TenantScope, ids: readonly string[]): Promise<VersionRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(serviceVersions)
      .where(tenantWhere(serviceVersions, scope, inArray(serviceVersions.id, [...ids])));
  }
  versionsOf(scope: TenantScope, definitionId: string): Promise<VersionRow[]> {
    return this.x
      .select()
      .from(serviceVersions)
      .where(tenantWhere(serviceVersions, scope, eq(serviceVersions.definitionId, definitionId)))
      .orderBy(desc(serviceVersions.versionNo));
  }
  draftsOf(scope: TenantScope, definitionIds: readonly string[]): Promise<VersionRow[]> {
    if (definitionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(serviceVersions)
      .where(
        tenantWhere(
          serviceVersions,
          scope,
          inArray(serviceVersions.definitionId, [...definitionIds]),
          eq(serviceVersions.status, 'DRAFT'),
        ),
      );
  }
  async nextVersionNo(scope: TenantScope, definitionId: string): Promise<number> {
    const [row] = await this.x
      .select({ n: max(serviceVersions.versionNo) })
      .from(serviceVersions)
      .where(tenantWhere(serviceVersions, scope, eq(serviceVersions.definitionId, definitionId)));
    return (row?.n ?? 0) + 1;
  }
  async updateVersion(
    scope: TenantScope,
    id: string,
    version: number | null,
    values: Partial<typeof serviceVersions.$inferInsert>,
  ): Promise<VersionRow | undefined> {
    const [row] = await this.x
      .update(serviceVersions)
      .set({ ...values, version: sql`${serviceVersions.version} + 1` })
      .where(
        tenantWhere(
          serviceVersions,
          scope,
          eq(serviceVersions.id, id),
          version === null ? undefined : eq(serviceVersions.version, version),
        ),
      )
      .returning();
    return row;
  }
  /** Replaces a draft's translations (the trigger refuses this on a published version). */
  async replaceVersionTranslations(versionId: string, rows: readonly VersionTranslationInput[]) {
    await this.x
      .delete(serviceVersionTranslations)
      .where(eq(serviceVersionTranslations.entityId, versionId));
    if (rows.length === 0) return;
    await this.x.insert(serviceVersionTranslations).values(
      rows.map((t) => ({
        entityId: versionId,
        locale: t.locale,
        name: t.name,
        shortDescription: t.shortDescription ?? null,
        description: t.description ?? null,
        guestPromptHints: t.guestPromptHints ?? null,
        fieldLabels: t.fieldLabels ?? {},
      })),
    );
  }
  /** Translations of versions the caller already loaded through a tenant-scoped query. */
  versionTranslations(ids: readonly string[]): Promise<VersionTranslationRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(serviceVersionTranslations)
      .where(inArray(serviceVersionTranslations.entityId, [...ids]))
      .orderBy(asc(serviceVersionTranslations.locale));
  }
  /** Serializes publishing of one definition (and request creation against it). */
  async lockDefinition(scope: TenantScope, id: string): Promise<DefinitionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(serviceDefinitions)
      .where(tenantWhere(serviceDefinitions, scope, eq(serviceDefinitions.id, id)))
      .for('update');
    return row;
  }
  publishedVersionsAt(
    scope: TenantScope,
    definitionIds: readonly string[],
  ): Promise<Array<{ definition: DefinitionRow; version: VersionRow }>> {
    if (definitionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select({ definition: serviceDefinitions, version: serviceVersions })
      .from(serviceDefinitions)
      .innerJoin(
        serviceVersions,
        and(
          eq(serviceVersions.id, serviceDefinitions.publishedVersionId),
          eq(serviceVersions.tenantId, serviceDefinitions.tenantId),
        ),
      )
      .where(
        tenantWhere(serviceDefinitions, scope, inArray(serviceDefinitions.id, [...definitionIds])),
      );
  }
}
