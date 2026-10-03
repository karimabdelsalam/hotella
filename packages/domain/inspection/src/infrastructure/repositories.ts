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
  type FindingRow,
  findings,
  type InspectionRow,
  inspections,
  type ResponseRow,
  responses,
  type TemplateItemRow,
  templateItems,
  templateItemTranslations,
  type TemplateRow,
  templates,
  type TemplateSectionRow,
  templateSections,
  templateSectionTranslations,
  templateTranslations,
  type TemplateVersionRow,
  templateVersions,
} from './schema';

export interface ItemTranslation {
  readonly locale: string;
  readonly label: string;
  readonly help: string | null;
  readonly optionLabels: Record<string, string>;
}

@Injectable()
export class InspectionRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- templates ----
  async insertTemplate(values: typeof templates.$inferInsert): Promise<TemplateRow | undefined> {
    const [row] = await this.x.insert(templates).values(values).onConflictDoNothing().returning();
    return row;
  }
  async template(scope: TenantScope, id: string): Promise<TemplateRow | undefined> {
    const [row] = await this.x
      .select()
      .from(templates)
      .where(tenantWhere(templates, scope, eq(templates.id, id)));
    return row;
  }
  templatesOf(scope: TenantScope): Promise<TemplateRow[]> {
    return this.x
      .select()
      .from(templates)
      .where(tenantWhere(templates, scope))
      .orderBy(asc(templates.code));
  }
  async putTemplateNames(
    id: string,
    names: ReadonlyArray<{ locale: string; name: string }>,
  ): Promise<void> {
    for (const n of names)
      await this.x
        .insert(templateTranslations)
        .values({ entityId: id, locale: n.locale, name: n.name })
        .onConflictDoUpdate({
          target: [templateTranslations.entityId, templateTranslations.locale],
          set: { name: n.name },
        });
  }
  async templateNames(ids: readonly string[]) {
    const rows = ids.length
      ? await this.x
          .select()
          .from(templateTranslations)
          .where(inArray(templateTranslations.entityId, [...ids]))
      : [];
    const out = new Map<string, Array<{ locale: string; name: string }>>();
    for (const r of rows)
      out.set(r.entityId, [...(out.get(r.entityId) ?? []), { locale: r.locale, name: r.name }]);
    return out;
  }

  // ---- versions ----
  versionsOf(scope: TenantScope, templateId: string): Promise<TemplateVersionRow[]> {
    return this.x
      .select()
      .from(templateVersions)
      .where(tenantWhere(templateVersions, scope, eq(templateVersions.templateId, templateId)))
      .orderBy(desc(templateVersions.versionNo));
  }
  async version(scope: TenantScope, id: string): Promise<TemplateVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(templateVersions)
      .where(tenantWhere(templateVersions, scope, eq(templateVersions.id, id)));
    return row;
  }
  async versionForUpdate(scope: TenantScope, id: string): Promise<TemplateVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(templateVersions)
      .where(tenantWhere(templateVersions, scope, eq(templateVersions.id, id)))
      .for('update');
    return row;
  }
  /** The latest published version of a template, the one new inspections pin. */
  async publishedVersion(
    scope: TenantScope,
    templateId: string,
  ): Promise<TemplateVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(templateVersions)
      .where(
        tenantWhere(
          templateVersions,
          scope,
          eq(templateVersions.templateId, templateId),
          eq(templateVersions.status, 'PUBLISHED'),
        ),
      )
      .orderBy(desc(templateVersions.versionNo))
      .limit(1);
    return row;
  }
  async insertVersion(values: typeof templateVersions.$inferInsert): Promise<TemplateVersionRow> {
    const [row] = await this.x.insert(templateVersions).values(values).returning();
    return row!;
  }
  async deleteVersion(scope: TenantScope, id: string): Promise<void> {
    await this.x
      .delete(templateVersions)
      .where(tenantWhere(templateVersions, scope, eq(templateVersions.id, id)));
  }
  async publish(scope: TenantScope, id: string, by: string | null): Promise<TemplateVersionRow> {
    const [row] = await this.x
      .update(templateVersions)
      .set({
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishedById: by,
        updatedAt: new Date(),
      })
      .where(tenantWhere(templateVersions, scope, eq(templateVersions.id, id)))
      .returning();
    return row!;
  }

  // ---- content ----
  async insertSection(
    values: typeof templateSections.$inferInsert,
    titles: ReadonlyArray<{ locale: string; title: string }>,
  ): Promise<TemplateSectionRow> {
    const [row] = await this.x.insert(templateSections).values(values).returning();
    for (const t of titles)
      await this.x
        .insert(templateSectionTranslations)
        .values({ entityId: row!.id, locale: t.locale, title: t.title });
    return row!;
  }
  async insertItem(
    values: typeof templateItems.$inferInsert,
    labels: readonly ItemTranslation[],
  ): Promise<TemplateItemRow> {
    const [row] = await this.x.insert(templateItems).values(values).returning();
    for (const l of labels)
      await this.x.insert(templateItemTranslations).values({
        entityId: row!.id,
        locale: l.locale,
        label: l.label,
        help: l.help,
        optionLabels: l.optionLabels,
      });
    return row!;
  }
  sectionsOf(versionId: string): Promise<TemplateSectionRow[]> {
    return this.x
      .select()
      .from(templateSections)
      .where(eq(templateSections.versionId, versionId))
      .orderBy(asc(templateSections.position));
  }
  itemsOf(versionId: string): Promise<TemplateItemRow[]> {
    return this.x
      .select()
      .from(templateItems)
      .where(eq(templateItems.versionId, versionId))
      .orderBy(asc(templateItems.position));
  }
  async sectionTitles(ids: readonly string[]) {
    const rows = ids.length
      ? await this.x
          .select()
          .from(templateSectionTranslations)
          .where(inArray(templateSectionTranslations.entityId, [...ids]))
      : [];
    const out = new Map<string, Array<{ locale: string; title: string }>>();
    for (const r of rows)
      out.set(r.entityId, [...(out.get(r.entityId) ?? []), { locale: r.locale, title: r.title }]);
    return out;
  }
  async itemLabels(ids: readonly string[]) {
    const rows = ids.length
      ? await this.x
          .select()
          .from(templateItemTranslations)
          .where(inArray(templateItemTranslations.entityId, [...ids]))
      : [];
    const out = new Map<string, ItemTranslation[]>();
    for (const r of rows)
      out.set(r.entityId, [
        ...(out.get(r.entityId) ?? []),
        { locale: r.locale, label: r.label, help: r.help, optionLabels: r.optionLabels },
      ]);
    return out;
  }

  // ---- inspections ----
  /** The next inspection number of the property (serialized per property inside the transaction). */
  async nextNumber(scope: PropertyScope): Promise<number> {
    await this.x.execute(
      sql`select pg_advisory_xact_lock(hashtext(${'inspection.no.' + scope.propertyId}))`,
    );
    const { rows } = await this.x.execute(
      sql`select coalesce(max(number), 0) + 1 as n from inspection.inspections where property_id = ${scope.propertyId}`,
    );
    return Number((rows[0] as { n: number | string }).n);
  }
  async insertInspection(values: typeof inspections.$inferInsert): Promise<InspectionRow> {
    const [row] = await this.x.insert(inspections).values(values).returning();
    return row!;
  }
  async inspection(scope: TenantScope, id: string): Promise<InspectionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(inspections)
      .where(tenantWhere(inspections, scope, eq(inspections.id, id)));
    return row;
  }
  async inspectionForUpdate(scope: TenantScope, id: string): Promise<InspectionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(inspections)
      .where(tenantWhere(inspections, scope, eq(inspections.id, id)))
      .for('update');
    return row;
  }
  async updateInspection(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<InspectionRow, 'status' | 'completedAt' | 'score' | 'result'>>,
  ): Promise<InspectionRow> {
    const [row] = await this.x
      .update(inspections)
      .set({ ...patch, updatedAt: new Date(), version: sql`${inspections.version} + 1` })
      .where(tenantWhere(inspections, scope, eq(inspections.id, id)))
      .returning();
    return row!;
  }
  inspectionsOf(
    scope: PropertyScope,
    filter: { statuses?: readonly InspectionRow['status'][]; locationId?: string },
  ): Promise<InspectionRow[]> {
    return this.x
      .select()
      .from(inspections)
      .where(
        propertyWhere(
          inspections,
          scope,
          ...(filter.statuses ? [inArray(inspections.status, [...filter.statuses])] : []),
          ...(filter.locationId ? [eq(inspections.locationId, filter.locationId)] : []),
        ),
      )
      .orderBy(desc(inspections.number))
      .limit(200);
  }

  // ---- answers and findings ----
  async insertResponse(values: typeof responses.$inferInsert): Promise<ResponseRow> {
    const [row] = await this.x.insert(responses).values(values).returning();
    return row!;
  }
  /** The latest answer per item (earlier answers stay in the table as history). */
  async latestResponses(scope: TenantScope, inspectionId: string): Promise<ResponseRow[]> {
    const rows = await this.x
      .select()
      .from(responses)
      .where(tenantWhere(responses, scope, eq(responses.inspectionId, inspectionId)))
      .orderBy(asc(responses.id));
    const latest = new Map<string, ResponseRow>();
    for (const r of rows) latest.set(r.itemId, r);
    return [...latest.values()];
  }
  async insertFinding(values: typeof findings.$inferInsert): Promise<FindingRow> {
    const [row] = await this.x.insert(findings).values(values).returning();
    return row!;
  }
  findingsOf(scope: TenantScope, inspectionId: string): Promise<FindingRow[]> {
    return this.x
      .select()
      .from(findings)
      .where(tenantWhere(findings, scope, eq(findings.inspectionId, inspectionId)))
      .orderBy(asc(findings.id));
  }
  openFindings(scope: PropertyScope): Promise<FindingRow[]> {
    return this.x
      .select()
      .from(findings)
      .where(propertyWhere(findings, scope, inArray(findings.status, ['OPEN', 'LINKED'])))
      .orderBy(desc(findings.id))
      .limit(200);
  }
  async findingForUpdate(scope: TenantScope, id: string): Promise<FindingRow | undefined> {
    const [row] = await this.x
      .select()
      .from(findings)
      .where(tenantWhere(findings, scope, eq(findings.id, id)))
      .for('update');
    return row;
  }
  async updateFinding(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<FindingRow, 'status' | 'workItemId' | 'resolvedAt'>>,
  ): Promise<FindingRow> {
    const [row] = await this.x
      .update(findings)
      .set({ ...patch, updatedAt: new Date(), version: sql`${findings.version} + 1` })
      .where(tenantWhere(findings, scope, eq(findings.id, id)))
      .returning();
    return row!;
  }
  async findingOfWorkItem(scope: TenantScope, workItemId: string): Promise<FindingRow | undefined> {
    const [row] = await this.x
      .select()
      .from(findings)
      .where(tenantWhere(findings, scope, eq(findings.workItemId, workItemId)));
    return row;
  }
  /** Completed inspections at a location since a time (readiness and arrival risk). */
  latestCompletedAt(scope: PropertyScope, locationId: string): Promise<InspectionRow | undefined> {
    return this.x
      .select()
      .from(inspections)
      .where(
        propertyWhere(
          inspections,
          scope,
          and(eq(inspections.locationId, locationId), eq(inspections.status, 'COMPLETED'))!,
        ),
      )
      .orderBy(desc(inspections.completedAt))
      .limit(1)
      .then((r) => r[0]);
  }
}
