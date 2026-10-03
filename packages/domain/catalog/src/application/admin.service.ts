import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ServiceVersionPublished } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { SettingsReader } from '@hotella/platform-settings';
import { CATALOG_DEFAULT_DUPLICATE_WINDOW_MINUTES } from '../domain/settings';
import type { FieldDefinition } from '../domain/rules';
import { CatalogRepositories } from '../infrastructure/repositories';
import type {
  CategoryRow,
  CategoryTranslationRow,
  DefinitionRow,
  VersionRow,
  VersionTranslationRow,
} from '../infrastructure/schema';
import type {
  CreateCategoryInput,
  CreateServiceInput,
  DraftInput,
  UpdateCategoryInput,
  UpdateDraftInput,
  UpdateServiceInput,
} from './schemas';

export const CATALOG = 'catalog';

/**
 * Catalog administration (Spec §7, BUILD_PLAN §9.2): categories and services for the whole tenant (`propertyId`
 * omitted; needs a tenant-wide membership) or one property, drafts, and publishing. A published version never changes
 * (rule 9; the database refuses it as well); editing creates the next draft.
 */
@Injectable()
export class CatalogAdminService {
  constructor(
    private readonly repo: CatalogRepositories,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly settings: SettingsReader,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  // ---- categories ----

  listCategories(scope: TenantScope, propertyId: string | null) {
    return this.act('catalog.read', scope, propertyId, 'read', async () => {
      await this.requireProperty(scope, propertyId);
      const rows = await this.repo.categoriesAt(scope, propertyId);
      const translations = await this.repo.categoryTranslations(rows.map((r) => r.id));
      return rows.map((r) => categoryView(r, translations));
    });
  }

  createCategory(scope: TenantScope, input: CreateCategoryInput) {
    const propertyId = input.propertyId ?? null;
    return this.act('catalog.manage', scope, propertyId, 'write', async () => {
      await this.requireProperty(scope, propertyId);
      if (input.parentId) await this.parentCategory(scope, propertyId, input.parentId);
      const row = await this.repo
        .insertCategory({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId,
          code: input.code,
          parentId: input.parentId ?? null,
          sortOrder: input.sortOrder,
          icon: input.icon ?? null,
        })
        .catch((e: unknown) => {
          throw unique(e, 'catalog.category.code_taken');
        });
      await this.repo.putCategoryTranslations(row.id, input.translations);
      await this.audit.record({
        action: 'catalog.category.create',
        entityType: 'service_category',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId,
        after: { code: row.code, locales: input.translations.map((t) => t.locale) },
      });
      return categoryView(row, await this.repo.categoryTranslations([row.id]));
    });
  }

  async updateCategory(scope: TenantScope, id: string, input: UpdateCategoryInput) {
    const current = await this.tx.read(() => this.findCategory(scope, id));
    return this.act('catalog.manage', scope, current.propertyId, 'write', async () => {
      if (input.parentId) {
        if (input.parentId === id) throw unprocessable('catalog.category.parent_invalid');
        await this.parentCategory(scope, current.propertyId, input.parentId);
      }
      const row = await this.repo.updateCategory(scope, id, input.version, {
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      if (!row) throw AppError.conflict('catalog.category.version_conflict');
      if (input.translations) await this.repo.putCategoryTranslations(id, input.translations);
      await this.audit.record({
        action: 'catalog.category.update',
        entityType: 'service_category',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: current.propertyId,
        before: { status: current.status, sortOrder: current.sortOrder },
        after: { status: row.status, sortOrder: row.sortOrder },
      });
      return categoryView(row, await this.repo.categoryTranslations([id]));
    });
  }

  // ---- services ----

  listServices(scope: TenantScope, propertyId: string | null) {
    return this.act('catalog.read', scope, propertyId, 'read', async () => {
      await this.requireProperty(scope, propertyId);
      const definitions = await this.repo.definitionsAt(scope, propertyId);
      return this.serviceViews(scope, definitions);
    });
  }

  async getService(scope: TenantScope, id: string) {
    const definition = await this.tx.read(() => this.findDefinition(scope, id));
    return this.act('catalog.read', scope, definition.propertyId, 'read', async () => {
      const versions = await this.repo.versionsOf(scope, id);
      const translations = await this.repo.versionTranslations(versions.map((v) => v.id));
      return {
        ...(await this.serviceViews(scope, [definition]))[0]!,
        versions: versions.map((v) => versionView(v, translations)),
      };
    });
  }

  createService(scope: TenantScope, input: CreateServiceInput) {
    const propertyId = input.propertyId ?? null;
    return this.act('catalog.manage', scope, propertyId, 'write', async () => {
      await this.requireProperty(scope, propertyId);
      await this.parentCategory(scope, propertyId, input.categoryId);
      const definition = await this.repo
        .insertDefinition({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId,
          code: input.code,
          categoryId: input.categoryId,
          sortOrder: input.sortOrder,
        })
        .catch((e: unknown) => {
          throw unique(e, 'catalog.service.code_taken');
        });
      const draft = await this.insertDraft(scope, definition, 1, input.draft);
      await this.audit.record({
        action: 'catalog.service.create',
        entityType: 'service_definition',
        entityId: definition.id,
        tenantId: scope.tenantId,
        propertyId,
        after: { code: definition.code, draft_version: draft.versionNo },
      });
      return (await this.serviceViews(scope, [definition]))[0]!;
    });
  }

  async updateService(scope: TenantScope, id: string, input: UpdateServiceInput) {
    const current = await this.tx.read(() => this.findDefinition(scope, id));
    return this.act('catalog.manage', scope, current.propertyId, 'write', async () => {
      if (input.categoryId) await this.parentCategory(scope, current.propertyId, input.categoryId);
      const row = await this.repo.updateDefinition(scope, id, input.version, {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      if (!row) throw AppError.conflict('catalog.service.version_conflict');
      await this.audit.record({
        action: 'catalog.service.update',
        entityType: 'service_definition',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: current.propertyId,
        before: { status: current.status, categoryId: current.categoryId },
        after: { status: row.status, categoryId: row.categoryId },
      });
      return (await this.serviceViews(scope, [row]))[0]!;
    });
  }

  /** Starts the next draft from the published version (or the latest one). One draft at a time. */
  async createDraft(scope: TenantScope, id: string) {
    const definition = await this.tx.read(() => this.findDefinition(scope, id));
    return this.act('catalog.manage', scope, definition.propertyId, 'write', async () => {
      await this.repo.lockDefinition(scope, id);
      const versions = await this.repo.versionsOf(scope, id);
      if (versions.some((v) => v.status === 'DRAFT'))
        throw AppError.conflict('catalog.service.draft_exists');
      const base =
        versions.find((v) => v.id === definition.publishedVersionId) ?? versions[0] ?? undefined;
      if (!base) throw AppError.notFound('catalog.version.not_found');
      const translations = await this.repo.versionTranslations([base.id]);
      const draft = await this.insertDraft(scope, definition, base.versionNo + 1, {
        departmentCode: base.departmentCode,
        priority: base.priority,
        workflowCode: base.workflowCode,
        requiredFields: base.requiredFields as DraftInput['requiredFields'],
        eligibility: base.eligibility as DraftInput['eligibility'],
        availability: base.availability as DraftInput['availability'],
        guestVisible: base.guestVisible,
        automationPolicy: base.automationPolicy as DraftInput['automationPolicy'],
        price: base.price as DraftInput['price'],
        duplicateWindowMinutes: base.duplicateWindowMinutes,
        translations: translations.map((t) => ({
          locale: t.locale,
          name: t.name,
          shortDescription: t.shortDescription,
          description: t.description,
          guestPromptHints: t.guestPromptHints,
          fieldLabels: t.fieldLabels as DraftInput['translations'][number]['fieldLabels'],
        })),
      });
      await this.audit.record({
        action: 'catalog.version.draft',
        entityType: 'service_version',
        entityId: draft.id,
        tenantId: scope.tenantId,
        propertyId: definition.propertyId,
        after: { code: definition.code, version_no: draft.versionNo, from: base.versionNo },
      });
      return versionView(draft, await this.repo.versionTranslations([draft.id]));
    });
  }

  async updateDraft(scope: TenantScope, versionId: string, input: UpdateDraftInput) {
    const { definition, version } = await this.tx.read(() => this.findVersion(scope, versionId));
    return this.act('catalog.manage', scope, definition.propertyId, 'write', async () => {
      if (version.status !== 'DRAFT')
        throw AppError.conflict('catalog.version.published_immutable');
      const {
        version: expected,
        translations,
        workflowCode,
        duplicateWindowMinutes,
        ...rest
      } = input;
      const values = {
        ...rest,
        ...(workflowCode !== undefined ? { workflowCode } : {}),
        ...(duplicateWindowMinutes !== undefined
          ? {
              duplicateWindowMinutes:
                duplicateWindowMinutes ?? (await this.defaultWindow(scope, definition)),
            }
          : {}),
      };
      const row = await this.repo.updateVersion(scope, versionId, expected, values);
      if (!row) throw AppError.conflict('catalog.version.version_conflict');
      if (translations) await this.repo.replaceVersionTranslations(versionId, translations);
      await this.audit.record({
        action: 'catalog.version.update',
        entityType: 'service_version',
        entityId: versionId,
        tenantId: scope.tenantId,
        propertyId: definition.propertyId,
        after: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
      return versionView(row, await this.repo.versionTranslations([versionId]));
    });
  }

  /** Freezes the draft and makes it the version new requests use (rule 9). */
  async publish(scope: TenantScope, versionId: string, expected: number) {
    const found = await this.tx.read(() => this.findVersion(scope, versionId));
    const { definition } = found;
    return this.act('catalog.publish', scope, definition.propertyId, 'write', async () => {
      const locked = (await this.repo.lockDefinition(scope, definition.id))!;
      const version = (await this.repo.version(scope, versionId))!;
      if (version.status !== 'DRAFT')
        throw AppError.conflict('catalog.version.published_immutable');
      if (version.version !== expected) throw AppError.conflict('catalog.version.version_conflict');
      const translations = await this.repo.versionTranslations([versionId]);
      checkPublishable(version, translations);
      if (definition.propertyId)
        await this.requireDepartment(scope, definition.propertyId, version.departmentCode);
      const previous = locked.publishedVersionId;
      const published = await this.markPublished(scope, definition, versionId, previous);
      await this.audit.record({
        action: 'catalog.version.publish',
        entityType: 'service_version',
        entityId: versionId,
        tenantId: scope.tenantId,
        propertyId: definition.propertyId,
        after: { code: definition.code, version_no: published.versionNo, superseded: previous },
      });
      return versionView(published, translations);
    });
  }

  // ---- shared ----

  /** Supersedes the previous version, publishes this one and announces it (inside the caller's transaction). */
  async markPublished(
    scope: TenantScope,
    definition: DefinitionRow,
    versionId: string,
    previous: string | null,
  ): Promise<VersionRow> {
    if (previous) await this.repo.updateVersion(scope, previous, null, { status: 'SUPERSEDED' });
    const actor = this.actors.get();
    const published = (await this.repo.updateVersion(scope, versionId, null, {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      publishedBy: actor?.type === 'USER' ? actor.id : null,
    }))!;
    await this.repo.updateDefinition(scope, definition.id, null, { publishedVersionId: versionId });
    await this.events.publish(ServiceVersionPublished, {
      tenantId: scope.tenantId,
      propertyId: definition.propertyId,
      source: CATALOG,
      aggregate: { type: 'service_definition', id: definition.id },
      payload: {
        definition_id: definition.id,
        version_id: versionId,
        service_code: definition.code,
        version_no: published.versionNo,
        property_id: definition.propertyId,
        superseded_version_id: previous,
      },
    });
    return published;
  }

  /** Inserts a draft in the current transaction (also used by the starter import). */
  async insertDraft(
    scope: TenantScope,
    definition: DefinitionRow,
    versionNo: number,
    input: DraftInput,
  ): Promise<VersionRow> {
    const draft = await this.repo.insertVersion({
      id: newId(),
      tenantId: scope.tenantId,
      definitionId: definition.id,
      versionNo,
      departmentCode: input.departmentCode,
      priority: input.priority,
      workflowCode: input.workflowCode ?? null,
      requiredFields: input.requiredFields,
      eligibility: input.eligibility,
      availability: input.availability,
      guestVisible: input.guestVisible,
      automationPolicy: input.automationPolicy,
      price: input.price,
      duplicateWindowMinutes:
        input.duplicateWindowMinutes ?? (await this.defaultWindow(scope, definition)),
    });
    await this.repo.replaceVersionTranslations(draft.id, input.translations);
    return draft;
  }

  private defaultWindow(scope: TenantScope, definition: DefinitionRow): Promise<number> {
    return this.settings.value(CATALOG_DEFAULT_DUPLICATE_WINDOW_MINUTES, {
      tenantId: scope.tenantId,
      propertyId: definition.propertyId,
    });
  }

  private async serviceViews(scope: TenantScope, definitions: readonly DefinitionRow[]) {
    const ids = definitions.map((d) => d.id);
    const published = await this.repo.versionsByIds(
      scope,
      definitions.map((d) => d.publishedVersionId).filter((v): v is string => v !== null),
    );
    const drafts = await this.repo.draftsOf(scope, ids);
    const translations = await this.repo.versionTranslations([
      ...published.map((v) => v.id),
      ...drafts.map((v) => v.id),
    ]);
    return definitions.map((d) => {
      const p = published.find((v) => v.id === d.publishedVersionId);
      const draft = drafts.find((v) => v.definitionId === d.id);
      return {
        id: d.id,
        propertyId: d.propertyId,
        code: d.code,
        categoryId: d.categoryId,
        status: d.status,
        sortOrder: d.sortOrder,
        version: d.version,
        published: p ? versionView(p, translations) : null,
        draft: draft ? versionView(draft, translations) : null,
      };
    });
  }

  private async requireProperty(scope: TenantScope, propertyId: string | null) {
    if (!propertyId) return;
    const property = isUuid(propertyId)
      ? await this.org.getProperty(scope.tenantId, propertyId)
      : null;
    if (!property) throw AppError.notFound('org.property.not_found');
  }

  private async requireDepartment(scope: TenantScope, propertyId: string, code: string) {
    const department = await this.org.getDepartment(scope.tenantId, propertyId, code);
    if (!department || department.status !== 'ACTIVE')
      throw new AppError('catalog.version.department_unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
        department: code,
      });
  }

  /** A category usable by an item of `propertyId`: tenant-wide, or of that same property. */
  private async parentCategory(scope: TenantScope, propertyId: string | null, id: string) {
    const category = isUuid(id) ? await this.repo.category(scope, id) : undefined;
    if (!category || (category.propertyId !== null && category.propertyId !== propertyId))
      throw unprocessable('catalog.category.not_found');
    return category;
  }

  private async findCategory(scope: TenantScope, id: string): Promise<CategoryRow> {
    const row = isUuid(id) ? await this.repo.category(scope, id) : undefined;
    if (!row) throw AppError.notFound('catalog.category.not_found');
    return row;
  }

  private async findDefinition(scope: TenantScope, id: string): Promise<DefinitionRow> {
    const row = isUuid(id) ? await this.repo.definition(scope, id) : undefined;
    if (!row) throw AppError.notFound('catalog.service.not_found');
    return row;
  }

  private async findVersion(scope: TenantScope, id: string) {
    const version = isUuid(id) ? await this.repo.version(scope, id) : undefined;
    if (!version) throw AppError.notFound('catalog.version.not_found');
    const definition = (await this.repo.definition(scope, version.definitionId))!;
    return { definition, version };
  }

  private act<T>(
    action: string,
    scope: TenantScope,
    propertyId: string | null,
    mode: 'read' | 'write',
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.gate.execute({ action, tenantId: scope.tenantId, propertyId }, () =>
      mode === 'read' ? this.tx.read(fn) : this.tx.run(fn),
    );
  }
}

/**
 * Publishing needs at least one translation, and every translation must label every field and choice option, so a
 * guest never sees a code (rule 7).
 */
export function checkPublishable(
  version: VersionRow,
  translations: readonly VersionTranslationRow[],
): void {
  if (translations.length === 0) throw unprocessable('catalog.version.translation_missing');
  const fields = version.requiredFields as FieldDefinition[];
  for (const t of translations) {
    const labels = (t.fieldLabels ?? {}) as Record<
      string,
      { label?: string; options?: Record<string, string> }
    >;
    for (const f of fields) {
      const label = labels[f.code];
      const missingOption = f.type === 'CHOICE' && f.options.some((o) => !label?.options?.[o]);
      if (!label?.label || missingOption)
        throw new AppError('catalog.version.label_missing', HttpStatus.UNPROCESSABLE_ENTITY, {
          field: f.code,
          locale: t.locale,
        });
    }
  }
}

export function categoryView(c: CategoryRow, translations: readonly CategoryTranslationRow[]) {
  return {
    id: c.id,
    propertyId: c.propertyId,
    code: c.code,
    parentId: c.parentId,
    sortOrder: c.sortOrder,
    icon: c.icon,
    status: c.status,
    version: c.version,
    translations: translations
      .filter((t) => t.entityId === c.id)
      .map((t) => ({ locale: t.locale, name: t.name, description: t.description })),
  };
}

export function versionView(v: VersionRow, translations: readonly VersionTranslationRow[]) {
  return {
    id: v.id,
    definitionId: v.definitionId,
    versionNo: v.versionNo,
    status: v.status,
    departmentCode: v.departmentCode,
    priority: v.priority,
    workflowCode: v.workflowCode,
    requiredFields: v.requiredFields,
    eligibility: v.eligibility,
    availability: v.availability,
    guestVisible: v.guestVisible,
    automationPolicy: v.automationPolicy,
    price: v.price,
    duplicateWindowMinutes: v.duplicateWindowMinutes,
    publishedAt: v.publishedAt,
    version: v.version,
    translations: translations
      .filter((t) => t.entityId === v.id)
      .map((t) => ({
        locale: t.locale,
        name: t.name,
        shortDescription: t.shortDescription,
        description: t.description,
        guestPromptHints: t.guestPromptHints,
        fieldLabels: t.fieldLabels,
      })),
  };
}

function unique(e: unknown, key: string): unknown {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  return code === '23505' ? AppError.conflict(key) : e;
}

export function unprocessable(
  key: string,
  params?: Record<string, string | number | boolean | null>,
): AppError {
  return new AppError(key, HttpStatus.UNPROCESSABLE_ENTITY, params);
}
