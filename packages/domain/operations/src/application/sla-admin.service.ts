import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PRIORITIES } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import {
  ALERT_SEVERITIES,
  ESCALATION_TRIGGERS,
  scheduleProblems,
  WEEKDAYS,
  type WeeklySchedule,
} from '../domain/sla';
import { SlaRepositories } from '../infrastructure/sla-repositories';
import type { BusinessHoursRow, SlaPolicyRow } from '../infrastructure/schema';
import { WorkItemKindRegistry } from './work.service';

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'UPPER_SNAKE_CASE, 2–32 characters');
const clock = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'HH:MM');

export const scheduleSchema = z.object({
  days: z.partialRecord(z.enum(WEEKDAYS), z.array(z.tuple([clock, clock])).max(6)),
  closedDates: z.array(z.iso.date()).max(366).optional(),
});

export const createBusinessHoursSchema = z.object({ code, schedule: scheduleSchema });
export const updateBusinessHoursSchema = z.object({
  version: z.number().int().min(1),
  schedule: scheduleSchema,
});

const escalationRuleSchema = z.object({
  level: z.number().int().min(1).max(9),
  trigger: z.enum(ESCALATION_TRIGGERS),
  offsetMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
  severity: z.enum(ALERT_SEVERITIES),
  notifyRoles: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9_]*$/),
    )
    .max(10)
    .default([]),
});

const policyFields = {
  matchKind: z.string().trim().toUpperCase().max(64).nullish(),
  matchServiceCode: z.string().trim().toUpperCase().max(64).nullish(),
  matchDepartmentCode: z.string().trim().toUpperCase().max(32).nullish(),
  matchPriority: z.enum(PRIORITIES).nullish(),
  responseMinutes: z.number().int().min(1).max(525_600).nullish(),
  resolutionMinutes: z.number().int().min(1).max(525_600),
  businessHoursCode: code.nullish(),
  pauseReasons: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .max(64),
    )
    .max(20)
    .default([]),
  escalationRules: z
    .array(escalationRuleSchema)
    .max(20)
    .default([])
    .refine(
      (rules) => new Set(rules.map((r) => `${r.trigger}:${r.level}`)).size === rules.length,
      'one rule per trigger and level',
    ),
};
export const createSlaPolicySchema = z.object({ code, ...policyFields });
export const updateSlaPolicySchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  ...policyFields,
});
export type CreateSlaPolicyInput = z.infer<typeof createSlaPolicySchema>;
export type UpdateSlaPolicyInput = z.infer<typeof updateSlaPolicySchema>;

function hoursView(h: BusinessHoursRow) {
  return { id: h.id, code: h.code, schedule: h.schedule, version: h.version };
}

/**
 * Business hours and SLA policies of a property (Spec §8.3), managed by `sla.manage`. Changes never touch running SLAs:
 * an SLA keeps the targets, clock and ladder it started with.
 */
@Injectable()
export class SlaAdminService {
  constructor(
    private readonly repo: SlaRepositories,
    private readonly kinds: WorkItemKindRegistry,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  listBusinessHours(scope: PropertyScope) {
    return this.manage(scope, true, async () =>
      (await this.repo.listBusinessHours(scope)).map(hoursView),
    );
  }

  createBusinessHours(scope: PropertyScope, input: z.infer<typeof createBusinessHoursSchema>) {
    return this.manage(scope, false, async () => {
      this.checkSchedule(input.schedule);
      if (await this.repo.businessHoursByCode(scope, input.code))
        throw AppError.conflict('ops.business_hours.code_taken', { code: input.code });
      const row = await this.repo.insertBusinessHours({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        code: input.code,
        schedule: input.schedule,
      });
      await this.record(
        'ops.business_hours.create',
        'business_hours',
        row.id,
        scope,
        null,
        hoursView(row),
      );
      return hoursView(row);
    });
  }

  updateBusinessHours(
    scope: PropertyScope,
    id: string,
    input: z.infer<typeof updateBusinessHoursSchema>,
  ) {
    return this.manage(scope, false, async () => {
      this.checkSchedule(input.schedule);
      const before = isUuid(id) ? await this.repo.businessHours(scope, id) : undefined;
      if (!before) throw AppError.notFound('ops.business_hours.not_found');
      const row = await this.repo.updateBusinessHours(scope, id, input.version, {
        schedule: input.schedule,
      });
      if (!row) throw AppError.conflict('ops.version_conflict', { version: before.version });
      await this.record(
        'ops.business_hours.update',
        'business_hours',
        id,
        scope,
        hoursView(before),
        hoursView(row),
      );
      return hoursView(row);
    });
  }

  listPolicies(scope: PropertyScope) {
    return this.manage(scope, true, async () => {
      const hours = new Map((await this.repo.listBusinessHours(scope)).map((h) => [h.id, h.code]));
      return (await this.repo.listPolicies(scope)).map((p) => policyView(p, hours));
    });
  }

  createPolicy(scope: PropertyScope, input: CreateSlaPolicyInput) {
    return this.manage(scope, false, async () => {
      if (await this.repo.policyByCode(scope, input.code))
        throw AppError.conflict('ops.sla_policy.code_taken', { code: input.code });
      const values = await this.policyValues(scope, input);
      const row = await this.repo.insertPolicy({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        code: input.code,
        ...values,
      });
      const hours = new Map((await this.repo.listBusinessHours(scope)).map((h) => [h.id, h.code]));
      await this.record(
        'ops.sla_policy.create',
        'sla_policy',
        row.id,
        scope,
        null,
        policyView(row, hours),
      );
      return policyView(row, hours);
    });
  }

  updatePolicy(scope: PropertyScope, id: string, input: UpdateSlaPolicyInput) {
    return this.manage(scope, false, async () => {
      const before = isUuid(id) ? await this.repo.policy(scope, id) : undefined;
      if (!before) throw AppError.notFound('ops.sla_policy.not_found');
      const values = await this.policyValues(scope, input);
      const row = await this.repo.updatePolicy(scope, id, input.version, {
        ...values,
        ...(input.status ? { status: input.status } : {}),
      });
      if (!row) throw AppError.conflict('ops.version_conflict', { version: before.version });
      const hours = new Map((await this.repo.listBusinessHours(scope)).map((h) => [h.id, h.code]));
      await this.record(
        'ops.sla_policy.update',
        'sla_policy',
        id,
        scope,
        policyView(before, hours),
        policyView(row, hours),
      );
      return policyView(row, hours);
    });
  }

  private async policyValues(
    scope: PropertyScope,
    input: CreateSlaPolicyInput | UpdateSlaPolicyInput,
  ) {
    if (input.matchKind && !this.kinds.get(input.matchKind))
      throw new AppError('ops.work_item.kind_unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
        kind: input.matchKind,
      });
    if (
      input.matchDepartmentCode &&
      !(await this.org.getDepartment(scope.tenantId, scope.propertyId, input.matchDepartmentCode))
    )
      throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
        field: 'matchDepartmentCode',
      });
    let businessHoursId: string | null = null;
    if (input.businessHoursCode) {
      const hours = await this.repo.businessHoursByCode(scope, input.businessHoursCode);
      if (!hours)
        throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
          field: 'businessHoursCode',
        });
      businessHoursId = hours.id;
    }
    return {
      matchKind: input.matchKind ?? null,
      matchServiceCode: input.matchServiceCode ?? null,
      matchDepartmentCode: input.matchDepartmentCode ?? null,
      matchPriority: input.matchPriority ?? null,
      responseMinutes: input.responseMinutes ?? null,
      resolutionMinutes: input.resolutionMinutes,
      businessHoursId,
      pauseReasons: input.pauseReasons,
      escalationRules: input.escalationRules,
    };
  }

  private checkSchedule(schedule: WeeklySchedule) {
    const problems = scheduleProblems(schedule);
    if (problems.length > 0)
      throw new AppError('ops.business_hours.invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
        problem: problems[0]!,
      });
  }

  private manage<T>(scope: PropertyScope, read: boolean, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'sla.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (read ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }

  private record(
    action: string,
    entityType: string,
    entityId: string,
    scope: PropertyScope,
    before: unknown,
    after: unknown,
  ) {
    return this.audit.record({
      action,
      entityType,
      entityId,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      ...(before ? { before: before as Record<string, unknown> } : {}),
      after: after as Record<string, unknown>,
    });
  }
}

function policyView(p: SlaPolicyRow, hours: ReadonlyMap<string, string>) {
  return {
    id: p.id,
    code: p.code,
    matchKind: p.matchKind,
    matchServiceCode: p.matchServiceCode,
    matchDepartmentCode: p.matchDepartmentCode,
    matchPriority: p.matchPriority,
    responseMinutes: p.responseMinutes,
    resolutionMinutes: p.resolutionMinutes,
    businessHoursCode: p.businessHoursId ? (hours.get(p.businessHoursId) ?? null) : null,
    pauseReasons: p.pauseReasons,
    escalationRules: p.escalationRules,
    status: p.status,
    version: p.version,
  };
}
