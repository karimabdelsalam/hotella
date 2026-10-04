import { HttpStatus, Injectable } from '@nestjs/common';
import { PlanVersionPublished } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { planProblems, type DraftLimit } from '../domain/plans';
import { CatalogRepositories } from '../infrastructure/repositories';
import type {
  PlanRow,
  PlanTranslationRow,
  PlanVersionItemRow,
  PlanVersionLimitRow,
  PlanVersionRow,
} from '../infrastructure/schema';
import { LicenseCatalogService } from './catalog.service';
import type {
  CreateDraftInput,
  CreatePlanInput,
  UpdateDraftInput,
  UpdatePlanInput,
  VersionActionInput,
} from './schemas';

const MANAGE = 'license.plan.manage';

/**
 * Plans and their versions (Spec §58, BUILD_PLAN 11.1). A plan is a commercial package; what it grants lives in
 * versions: one draft at a time, edited freely, then published — frozen for good (rule 9, also enforced by the
 * database) — and later retired so no new subscription takes it while existing ones keep it.
 */
@Injectable()
export class PlanService {
  constructor(
    private readonly repo: CatalogRepositories,
    private readonly catalog: LicenseCatalogService,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
  ) {}

  list() {
    return this.act('read', async () => {
      const rows = await this.repo.listPlans();
      const ids = rows.map((r) => r.id);
      const [translations, versions] = await Promise.all([
        this.repo.planTranslations(ids),
        this.repo.versionsOf(ids),
      ]);
      return rows.map((p) => ({
        ...planView(p, translations),
        versions: versions
          .filter((v) => v.planId === p.id)
          .map((v) => ({
            id: v.id,
            versionNo: v.versionNo,
            status: v.status,
            publishedAt: v.publishedAt,
          })),
      }));
    });
  }

  get(id: string) {
    return this.act('read', () => this.full(id));
  }

  create(input: CreatePlanInput) {
    return this.act('write', async () => {
      const plan = await this.repo
        .insertPlan({ id: newId(), code: input.code })
        .catch((e: unknown) => {
          throw unique(e, 'license.plan.code_taken');
        });
      await this.repo.putPlanTranslations(plan.id, input.translations);
      await this.repo.insertVersion({
        id: newId(),
        planId: plan.id,
        versionNo: 1,
        createdById: this.actorId(),
      });
      await this.audit.record({
        action: 'license.plan.create',
        entityType: 'license_plan',
        entityId: plan.id,
        tenantId: null,
        after: { code: plan.code, locales: input.translations.map((t) => t.locale) },
      });
      return this.full(plan.id);
    });
  }

  update(id: string, input: UpdatePlanInput) {
    return this.act('write', async () => {
      const current = await this.findPlan(id);
      const row = await this.repo.updatePlan(id, input.version, {
        ...(input.status ? { status: input.status } : {}),
      });
      if (!row) throw AppError.conflict('license.plan.version_conflict');
      if (input.translations) await this.repo.putPlanTranslations(id, input.translations);
      await this.audit.record({
        action: 'license.plan.update',
        entityType: 'license_plan',
        entityId: id,
        tenantId: null,
        before: { status: current.status },
        after: { status: row.status, locales: input.translations?.map((t) => t.locale) ?? null },
      });
      return this.full(id);
    });
  }

  /** The next draft, copied from a version of the plan (default: the latest published one). One draft at a time. */
  createDraft(planId: string, input: CreateDraftInput) {
    return this.act('write', async () => {
      const plan = await this.repo.lockPlan(planId);
      if (!plan) throw AppError.notFound('license.plan.not_found');
      const versions = await this.repo.versionsOf([planId]);
      if (versions.some((v) => v.status === 'DRAFT'))
        throw AppError.conflict('license.plan.draft_exists');
      const source = input.fromVersionId
        ? versions.find((v) => v.id === input.fromVersionId)
        : versions.find((v) => v.status === 'PUBLISHED');
      if (input.fromVersionId && !source) throw AppError.notFound('license.plan_version.not_found');
      const draft = await this.repo.insertVersion({
        id: newId(),
        planId,
        versionNo: await this.repo.nextVersionNo(planId),
        notes: source?.notes ?? null,
        createdById: this.actorId(),
      });
      if (source) {
        const [items, limits] = await Promise.all([
          this.repo.items([source.id]),
          this.repo.limits([source.id]),
        ]);
        await this.repo.replaceContent(
          draft.id,
          items.map((i) => i.capabilityCode),
          limits.map(limitInput),
        );
      }
      await this.audit.record({
        action: 'license.plan_version.draft',
        entityType: 'license_plan_version',
        entityId: draft.id,
        tenantId: null,
        after: { plan: plan.code, version_no: draft.versionNo, from: source?.versionNo ?? null },
      });
      return this.versionFull(planId, draft.id);
    });
  }

  updateDraft(planId: string, versionId: string, input: UpdateDraftInput) {
    return this.act('write', async () => {
      const version = await this.findVersion(planId, versionId);
      if (version.status !== 'DRAFT') throw AppError.conflict('license.plan_version.not_draft');
      const [currentItems, currentLimits] = await Promise.all([
        this.repo.items([versionId]),
        this.repo.limits([versionId]),
      ]);
      const items = input.items ?? currentItems.map((i) => i.capabilityCode);
      const limits = input.limits ?? currentLimits.map(limitInput);
      refuse(planProblems({ items, limits }, await this.catalog.view(), false));
      const row = await this.repo.updateVersion(versionId, input.version, {
        ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
      });
      if (!row) throw AppError.conflict('license.plan_version.version_conflict');
      if (input.items || input.limits) await this.repo.replaceContent(versionId, items, limits);
      await this.audit.record({
        action: 'license.plan_version.update',
        entityType: 'license_plan_version',
        entityId: versionId,
        tenantId: null,
        before: { items: currentItems.map((i) => i.capabilityCode), limits: currentLimits.length },
        after: { items: [...new Set(items)].sort(), limits: limits.length },
      });
      return this.versionFull(planId, versionId);
    });
  }

  publish(planId: string, versionId: string, input: VersionActionInput) {
    return this.act('write', async () => {
      const plan = await this.repo.lockPlan(planId);
      if (!plan) throw AppError.notFound('license.plan.not_found');
      if (plan.status !== 'ACTIVE') throw AppError.conflict('license.plan.retired');
      const version = await this.findVersion(planId, versionId);
      if (version.status !== 'DRAFT') throw AppError.conflict('license.plan_version.not_draft');
      if ((await this.repo.planTranslations([planId])).length === 0)
        throw unprocessable('license.plan.translation_missing');
      const [items, limits] = await Promise.all([
        this.repo.items([versionId]),
        this.repo.limits([versionId]),
      ]);
      const codes = items.map((i) => i.capabilityCode);
      refuse(
        planProblems(
          { items: codes, limits: limits.map(limitInput) },
          await this.catalog.view(),
          true,
        ),
      );
      const row = await this.repo.updateVersion(versionId, input.version, {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishedById: this.actorId(),
      });
      if (!row) throw AppError.conflict('license.plan_version.version_conflict');
      await this.events.publish(PlanVersionPublished, {
        tenantId: null,
        source: 'license',
        aggregate: { type: 'license_plan_version', id: versionId },
        payload: {
          plan_id: planId,
          plan_code: plan.code,
          plan_version_id: versionId,
          version_no: row.versionNo,
          capabilities: codes,
        },
      });
      await this.audit.record({
        action: 'license.plan_version.publish',
        entityType: 'license_plan_version',
        entityId: versionId,
        tenantId: null,
        after: {
          plan: plan.code,
          version_no: row.versionNo,
          capabilities: codes,
          limits: limits.length,
        },
      });
      return this.versionFull(planId, versionId);
    });
  }

  /** No new subscription takes a retired version; subscriptions on it keep it until changed. */
  retire(planId: string, versionId: string, input: VersionActionInput) {
    return this.act('write', async () => {
      const version = await this.findVersion(planId, versionId);
      if (version.status !== 'PUBLISHED')
        throw AppError.conflict('license.plan_version.not_published');
      const row = await this.repo.updateVersion(versionId, input.version, {
        status: 'RETIRED',
        retiredAt: new Date(),
      });
      if (!row) throw AppError.conflict('license.plan_version.version_conflict');
      await this.audit.record({
        action: 'license.plan_version.retire',
        entityType: 'license_plan_version',
        entityId: versionId,
        tenantId: null,
        before: { status: 'PUBLISHED' },
        after: { status: 'RETIRED' },
      });
      return this.versionFull(planId, versionId);
    });
  }

  // ---- helpers ----

  private async full(id: string) {
    const plan = await this.findPlan(id);
    const [translations, versions] = await Promise.all([
      this.repo.planTranslations([id]),
      this.repo.versionsOf([id]),
    ]);
    const ids = versions.map((v) => v.id);
    const [items, limits] = await Promise.all([this.repo.items(ids), this.repo.limits(ids)]);
    return {
      ...planView(plan, translations),
      versions: versions.map((v) => versionView(v, items, limits)),
    };
  }

  private async versionFull(planId: string, versionId: string) {
    const version = await this.findVersion(planId, versionId);
    const [items, limits] = await Promise.all([
      this.repo.items([versionId]),
      this.repo.limits([versionId]),
    ]);
    return versionView(version, items, limits);
  }

  private async findPlan(id: string): Promise<PlanRow> {
    const plan = isUuid(id) ? await this.repo.plan(id) : undefined;
    if (!plan) throw AppError.notFound('license.plan.not_found');
    return plan;
  }

  private async findVersion(planId: string, id: string): Promise<PlanVersionRow> {
    const version = isUuid(planId) && isUuid(id) ? await this.repo.version(planId, id) : undefined;
    if (!version) throw AppError.notFound('license.plan_version.not_found');
    return version;
  }

  private actorId(): string | null {
    const id = this.actors.require().id;
    return id && isUuid(id) ? id : null;
  }

  private act<T>(mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    return this.gate.execute({ action: MANAGE, tenantId: null }, () =>
      mode === 'read' ? this.tx.read(fn) : this.tx.run(fn),
    );
  }
}

function limitInput(l: PlanVersionLimitRow): DraftLimit {
  return {
    metricCode: l.metricCode,
    scope: l.scope,
    period: l.period,
    limitValue: l.limitValue,
    enforcement: l.enforcement,
  };
}

export function planView(p: PlanRow, translations: readonly PlanTranslationRow[]) {
  return {
    id: p.id,
    code: p.code,
    status: p.status,
    version: p.version,
    translations: translations
      .filter((t) => t.entityId === p.id)
      .map((t) => ({ locale: t.locale, name: t.name, description: t.description })),
  };
}

export function versionView(
  v: PlanVersionRow,
  items: readonly PlanVersionItemRow[],
  limits: readonly PlanVersionLimitRow[],
) {
  return {
    id: v.id,
    planId: v.planId,
    versionNo: v.versionNo,
    status: v.status,
    notes: v.notes,
    publishedAt: v.publishedAt,
    retiredAt: v.retiredAt,
    version: v.version,
    items: items.filter((i) => i.planVersionId === v.id).map((i) => i.capabilityCode),
    limits: limits.filter((l) => l.planVersionId === v.id).map(limitInput),
  };
}

function refuse(problems: ReturnType<typeof planProblems>): void {
  const first = problems[0];
  if (first) throw unprocessable(first.key, first.params);
}

function unique(e: unknown, key: string): unknown {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  return code === '23505' ? AppError.conflict(key) : e;
}

function unprocessable(key: string, params?: Record<string, string>): AppError {
  return new AppError(key, HttpStatus.UNPROCESSABLE_ENTITY, params);
}
