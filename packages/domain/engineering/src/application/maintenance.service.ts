import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MeterReadingRecorded, PmDue } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { isDue, METER_KINDS, type PmTrigger, readingAccepted } from '../domain/pm';
import { EngineeringRepositories } from '../infrastructure/repositories';
import type { PmPlanRow } from '../infrastructure/schema';
import { WorkOrderService } from './work-order.service';

const isoDay = z.iso.date();
const steps = z
  .array(
    z.object({
      text: z.string().trim().min(1).max(500),
      requiresReading: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(100);

export const createMeterSchema = z.object({
  assetId: z.uuid(),
  kind: z.enum(METER_KINDS),
  unit: z.string().trim().min(1).max(16),
});
export const readingSchema = z.object({
  value: z.number().finite(),
  /** The meter was replaced: this reading starts again from its value. */
  reset: z.boolean().default(false),
  readAt: z.iso
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .optional(),
});
export const createProcedureSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  title: z.string().trim().min(1).max(200),
  steps,
  estimatedMinutes: z.number().int().min(1).max(10_000).optional(),
});
export const draftVersionSchema = z.object({
  steps,
  estimatedMinutes: z.number().int().min(1).max(10_000).optional(),
});
const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CALENDAR'), everyDays: z.number().int().min(1).max(3650) }),
  z.object({ kind: z.literal('METER'), meterId: z.uuid(), everyUnits: z.number().positive() }),
  z
    .object({
      kind: z.literal('CONDITION'),
      meterId: z.uuid(),
      above: z.number().optional(),
      below: z.number().optional(),
    })
    .refine((t) => t.above !== undefined || t.below !== undefined, { message: 'above or below' }),
]);
export const createPlanSchema = z.object({
  assetId: z.uuid(),
  procedureId: z.uuid(),
  trigger: triggerSchema,
  leadDays: z.number().int().min(0).max(60).default(0),
  /** When the work was last done (property-local day); today when omitted. */
  lastDoneOn: isoDay.optional(),
  lastDoneValue: z.number().optional(),
});
export const updatePlanSchema = z.object({
  version: z.number().int().min(1),
  active: z.boolean().optional(),
  leadDays: z.number().int().min(0).max(60).optional(),
});

/**
 * Meters and preventive maintenance (Spec §10.6–§10.7, BUILD_PLAN 8.3). Readings are append-only; procedures are
 * versioned and a published version never changes; the hourly sweep opens each due plan's PREVENTIVE work with the
 * latest published procedure version pinned, one open work order per plan at a time.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly repo: EngineeringRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    private readonly orders: WorkOrderService,
    private readonly ctx: RequestContext,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---- meters ----

  createMeter(scope: PropertyScope, input: z.infer<typeof createMeterSchema>) {
    return this.pm(scope, 'eng.asset.manage', async () => {
      await this.asset(scope, input.assetId);
      const row = await this.repo.insertMeter({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        ...input,
      });
      if (!row) throw AppError.conflict('eng.meter.exists');
      return row;
    });
  }

  listMeters(scope: PropertyScope, assetId?: string) {
    return this.gate.execute(
      { action: 'eng.asset.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.repo.metersOf(scope, assetId)),
    );
  }

  /** Engineers read meters (`eng.work_order.manage`); a cumulative meter never goes back unless it was replaced. */
  recordReading(scope: PropertyScope, meterId: string, input: z.infer<typeof readingSchema>) {
    return this.pm(scope, 'eng.work_order.manage', async () => {
      const meter = isUuid(meterId) ? await this.repo.meterForUpdate(scope, meterId) : undefined;
      if (!meter) throw AppError.notFound('eng.meter.not_found');
      if (!input.reset && !readingAccepted(meter.kind, meter.lastValue, input.value))
        throw AppError.conflict('eng.meter.reading_lower', { last: meter.lastValue ?? 0 });
      const actor = this.actors.require();
      const row = await this.repo.recordReading(scope, meter.id, {
        id: newId(),
        value: input.value,
        reset: input.reset,
        source: 'STAFF',
        actorType: actor.type,
        actorId: isUuid(actor.id) ? actor.id : null,
        readAt: input.readAt ?? new Date(),
      });
      await this.events.publish(MeterReadingRecorded, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'eng',
        aggregate: { type: 'meter', id: meter.id },
        payload: {
          meter_id: meter.id,
          asset_id: meter.assetId,
          kind: meter.kind,
          value: input.value,
          reset: input.reset,
          source: 'STAFF',
        },
      });
      return row;
    });
  }

  // ---- procedures (tenant) ----

  createProcedure(scope: TenantScope, input: z.infer<typeof createProcedureSchema>) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const procedure = await this.repo.insertProcedure({
          id: newId(),
          tenantId: scope.tenantId,
          code: input.code,
          title: input.title,
        });
        if (!procedure) throw AppError.conflict('eng.procedure.code_taken');
        const draft = await this.repo.insertProcedureVersion({
          id: newId(),
          tenantId: scope.tenantId,
          procedureId: procedure.id,
          versionNo: 1,
          steps: input.steps,
          estimatedMinutes: input.estimatedMinutes ?? null,
        });
        await this.audit.record({
          action: 'eng.procedure.create',
          entityType: 'pm_procedure',
          entityId: procedure.id,
          tenantId: scope.tenantId,
          after: { code: procedure.code, steps: input.steps.length },
        });
        return { ...procedure, versions: [draft] };
      }),
    );
  }

  listProcedures(scope: TenantScope) {
    return this.gate.execute({ action: 'eng.asset.read', tenantId: scope.tenantId }, () =>
      this.tx.read(async () => {
        const out = [];
        for (const p of await this.repo.procedures(scope))
          out.push({ ...p, versions: await this.repo.procedureVersions(scope, p.id) });
        return out;
      }),
    );
  }

  /** A new draft after the latest version (the published ones stay as they are). */
  newDraft(scope: TenantScope, procedureId: string, input: z.infer<typeof draftVersionSchema>) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const procedure = isUuid(procedureId)
          ? await this.repo.procedure(scope, procedureId)
          : undefined;
        if (!procedure) throw AppError.notFound('eng.procedure.not_found');
        const versions = await this.repo.procedureVersions(scope, procedure.id);
        if (versions.some((v) => v.status === 'DRAFT'))
          throw AppError.conflict('eng.procedure.draft_exists');
        return this.repo.insertProcedureVersion({
          id: newId(),
          tenantId: scope.tenantId,
          procedureId: procedure.id,
          versionNo: (versions.at(-1)?.versionNo ?? 0) + 1,
          steps: input.steps,
          estimatedMinutes: input.estimatedMinutes ?? null,
        });
      }),
    );
  }

  /** Publishing freezes the version (a trigger refuses later edits); new preventive work follows it. */
  publish(scope: TenantScope, versionId: string) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const version = isUuid(versionId)
          ? await this.repo.procedureVersionForUpdate(scope, versionId)
          : undefined;
        if (!version) throw AppError.notFound('eng.procedure.not_found');
        if (version.status !== 'DRAFT') throw AppError.conflict('eng.procedure.not_draft');
        const row = await this.repo.updateProcedureVersion(scope, version.id, {
          status: 'PUBLISHED',
          publishedAt: new Date(),
        });
        await this.audit.record({
          action: 'eng.procedure.publish',
          entityType: 'pm_procedure_version',
          entityId: row.id,
          tenantId: scope.tenantId,
          after: { procedure_id: row.procedureId, version_no: row.versionNo },
        });
        return row;
      }),
    );
  }

  // ---- plans (property) ----

  createPlan(scope: PropertyScope, input: z.infer<typeof createPlanSchema>) {
    return this.pm(scope, 'eng.pm.manage', async () => {
      const asset = await this.asset(scope, input.assetId);
      if (!(await this.repo.procedure(scope, input.procedureId)))
        throw AppError.notFound('eng.procedure.not_found');
      if (input.trigger.kind !== 'CALENDAR') {
        const meter = await this.repo.meter(scope, input.trigger.meterId);
        if (!meter || meter.assetId !== asset.id) throw AppError.notFound('eng.meter.not_found');
      }
      const row = await this.repo.insertPlan({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        assetId: asset.id,
        procedureId: input.procedureId,
        trigger: input.trigger as PmTrigger,
        leadDays: input.leadDays,
        lastDoneOn: input.lastDoneOn ?? (await this.today(scope, new Date())),
        lastDoneValue: input.lastDoneValue ?? null,
      });
      await this.audit.record({
        action: 'eng.pm_plan.create',
        entityType: 'pm_plan',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { asset_id: row.assetId, trigger: row.trigger.kind },
      });
      return row;
    });
  }

  listPlans(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'eng.work_order.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.repo.plansOf(scope)),
    );
  }

  updatePlan(scope: PropertyScope, id: string, input: z.infer<typeof updatePlanSchema>) {
    return this.pm(scope, 'eng.pm.manage', async () => {
      const plan = isUuid(id) ? await this.repo.planForUpdate(scope, id) : undefined;
      if (!plan || plan.propertyId !== scope.propertyId)
        throw AppError.notFound('eng.pm_plan.not_found');
      if (plan.version !== input.version) throw AppError.conflict('eng.pm_plan.version_conflict');
      return this.repo.updatePlan(scope, plan.id, {
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.leadDays !== undefined ? { leadDays: input.leadDays } : {}),
      });
    });
  }

  // ---- the due sweep (worker, hourly) ----

  /** Opens the PREVENTIVE work of every due plan; one property's failure does not hold the others back. */
  async generateDue(now = new Date()): Promise<number> {
    const plans = await this.tx.read(() => this.repo.plansToCheck());
    let created = 0;
    for (const plan of plans) {
      try {
        const opened = await this.ctx.run(
          { tenant_id: plan.tenantId, property_id: plan.propertyId, actor_type: 'SYSTEM' },
          () => this.openIfDue(plan, now),
        );
        if (opened) created++;
      } catch (err) {
        this.logger.warn({ err, pm_plan_id: plan.id }, 'preventive work not created');
      }
    }
    if (created > 0) this.logger.info({ created }, 'preventive work created');
    return created;
  }

  private async openIfDue(candidate: PmPlanRow, now: Date): Promise<boolean> {
    const scope = { tenantId: candidate.tenantId, propertyId: candidate.propertyId };
    return this.tx.run(async () => {
      const plan = await this.repo.planForUpdate(scope, candidate.id);
      if (!plan || !plan.active || plan.openWorkOrderId) return false;
      const meter =
        plan.trigger.kind === 'CALENDAR'
          ? undefined
          : await this.repo.meter(scope, plan.trigger.meterId);
      const due = isDue(
        plan.trigger,
        { lastDoneOn: plan.lastDoneOn, lastDoneValue: plan.lastDoneValue },
        {
          today: await this.today(scope, now),
          leadDays: plan.leadDays,
          meterValue: meter?.lastValue ?? null,
        },
      );
      if (!due) return false;
      const version = await this.repo.publishedVersion(scope, plan.procedureId);
      if (!version) {
        this.logger.warn({ pm_plan_id: plan.id }, 'due plan has no published procedure');
        return false;
      }
      const asset = (await this.repo.asset(scope, plan.assetId))!;
      if (asset.status !== 'ACTIVE') return false;
      const order = await this.orders.openPreventive(
        scope,
        { id: plan.id, assetId: asset.id, locationId: asset.locationId },
        version.id,
      );
      await this.repo.updatePlan(scope, plan.id, { openWorkOrderId: order.id });
      await this.events.publish(PmDue, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'eng',
        aggregate: { type: 'pm_plan', id: plan.id },
        payload: {
          plan_id: plan.id,
          asset_id: asset.id,
          work_order_id: order.id,
          procedure_version_id: version.id,
          trigger: plan.trigger.kind,
        },
      });
      return true;
    });
  }

  // ---- helpers ----

  private pm<T>(scope: PropertyScope, action: string, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.run(fn),
    );
  }

  private async asset(scope: PropertyScope, id: string) {
    const a = isUuid(id) ? await this.repo.asset(scope, id) : undefined;
    if (!a || a.propertyId !== scope.propertyId) throw AppError.notFound('eng.asset.not_found');
    return a;
  }

  private async today(scope: PropertyScope, at: Date): Promise<string> {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    return new Intl.DateTimeFormat('en-CA', { timeZone: property?.timezone ?? 'UTC' }).format(at);
  }
}
