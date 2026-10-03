import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  type EventEnvelope,
  WorkItemStatusChanged,
  WorkOrderClosed,
  WorkOrderCreated,
} from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  defaultPriority,
  downtimeMinutes,
  missingCoding,
  statusFor,
  underWarranty,
  WORK_ORDER_TYPES,
} from '../domain/work-orders';
import { EngineeringRepositories } from '../infrastructure/repositories';
import type { FailureCodeRow, WorkOrderRow } from '../infrastructure/schema';

export const ENG_WORK_ORDER_KIND = 'ENG_WORK_ORDER';
const ENG = 'eng';
const ENG_DEPARTMENT = 'ENG';
const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,59}$/);
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const priority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

export const createWorkOrderSchema = z
  .object({
    type: z.enum(WORK_ORDER_TYPES),
    assetId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    symptomCode: code.optional(),
    diagnosis: z.string().trim().max(2000).optional(),
    priority: priority.optional(),
  })
  .refine((v) => v.assetId || v.locationId, { message: 'assetId or locationId' });
export const fromRequestSchema = z.object({
  workItemId: z.uuid(),
  assetId: z.uuid().optional(),
  symptomCode: code.optional(),
});
const codingFields = {
  symptomCode: code.nullable().optional(),
  failureModeCode: code.nullable().optional(),
  causeCode: code.nullable().optional(),
  resolutionCode: code.nullable().optional(),
  diagnosis: z.string().trim().max(2000).nullable().optional(),
  downtimeStartedAt: instant.nullable().optional(),
  downtimeEndedAt: instant.nullable().optional(),
};
export const updateWorkOrderSchema = z.object({
  version: z.number().int().min(1),
  assetId: z.uuid().nullable().optional(),
  ...codingFields,
});
export const completeWorkOrderSchema = z.object(codingFields);
export const listWorkOrdersSchema = z.object({
  status: z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'])))
    .optional(),
  assetId: z.uuid().optional(),
});
export const createPartSchema = z.object({
  partNumber: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(16).default('EA'),
  onHand: z.number().min(0).max(1e9).default(0),
  reorderLevel: z.number().min(0).max(1e9).default(0),
});
export const receivePartSchema = z.object({ quantity: z.number().positive().max(1e9) });
export const usePartSchema = z.object({
  partId: z.uuid(),
  quantity: z.number().positive().max(1e6),
});
export const warrantyDecisionSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['OPENED', 'CLOSED', 'DISMISSED']),
  note: z.string().trim().max(500).optional(),
});

type Coding = Partial<
  Pick<WorkOrderRow, 'symptomCode' | 'failureModeCode' | 'causeCode' | 'resolutionCode'>
>;
const CODE_KIND: Record<keyof Required<Coding>, FailureCodeRow['kind']> = {
  symptomCode: 'SYMPTOM',
  failureModeCode: 'FAILURE_MODE',
  causeCode: 'CAUSE',
  resolutionCode: 'RESOLUTION',
};

/**
 * Work orders (Spec §10.4–§10.9, BUILD_PLAN 8.2) on the operations engine: a work order is an `ENG_WORK_ORDER` work
 * item for Engineering at the asset's place, or adopts the work item of a guest request so one piece of work closes
 * both. It follows its work item; failures are coded with the taxonomy before they close; downtime, parts and a
 * warranty suggestion are kept with it.
 */
@Injectable()
export class WorkOrderService {
  static readonly consumes = [WorkItemStatusChanged];

  constructor(
    private readonly repo: EngineeringRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---- opening work ----

  create(scope: PropertyScope, input: z.infer<typeof createWorkOrderSchema>) {
    return this.manage(scope, async () => {
      const asset = input.assetId ? await this.asset(scope, input.assetId) : null;
      const locationId = input.locationId ?? asset!.locationId;
      if (!(await this.org.getLocation(scope.tenantId, scope.propertyId, locationId)))
        throw AppError.notFound('org.location.not_found');
      if (input.symptomCode) await this.checkCodes(scope, { symptomCode: input.symptomCode });
      return this.open(scope, {
        type: input.type,
        source: 'STAFF',
        assetId: asset?.id ?? null,
        locationId,
        symptomCode: input.symptomCode ?? null,
        diagnosis: input.diagnosis ?? null,
        priority: input.priority ?? defaultPriority(input.type, 'STAFF'),
        workItemId: null,
      });
    });
  }

  /**
   * Engineering takes over a guest's request: the work order adopts the request's work item (one piece of work, so
   * finishing it also completes the guest's request) and finds the equipment when the room has exactly one.
   */
  fromRequest(scope: PropertyScope, input: z.infer<typeof fromRequestSchema>) {
    return this.manage(scope, async () => {
      const work = await this.ops.getWorkItem(scope.tenantId, input.workItemId);
      if (!work || work.propertyId !== scope.propertyId)
        throw AppError.notFound('ops.work_item.not_found');
      if (work.status === 'RESOLVED' || work.status === 'CANCELLED')
        throw AppError.conflict('eng.work_order.work_closed');
      if (!work.locationId) throw AppError.conflict('eng.work_order.no_location');
      if (await this.repo.workOrderOfWorkItem(scope, work.id))
        throw AppError.conflict('eng.work_order.already_converted');
      let assetId: string | null = null;
      if (input.assetId) assetId = (await this.asset(scope, input.assetId)).id;
      else {
        const here = (
          await this.repo.assetsOf(scope, { locationIds: [work.locationId], parentAssetId: null })
        ).filter((a) => a.status === 'ACTIVE');
        if (here.length === 1) assetId = here[0]!.id;
      }
      if (input.symptomCode) await this.checkCodes(scope, { symptomCode: input.symptomCode });
      return this.open(scope, {
        type: 'CORRECTIVE',
        source: 'GUEST_REQUEST',
        assetId,
        locationId: work.locationId,
        symptomCode: input.symptomCode ?? null,
        diagnosis: null,
        priority: work.priority,
        workItemId: work.id,
      });
    });
  }

  /** The due sweep opens a plan's PREVENTIVE work with the procedure version it must follow (system actor). */
  openPreventive(
    scope: PropertyScope,
    plan: { id: string; assetId: string; locationId: string },
    procedureVersionId: string,
  ): Promise<WorkOrderRow> {
    return this.open(scope, {
      type: 'PREVENTIVE',
      source: 'PM',
      assetId: plan.assetId,
      locationId: plan.locationId,
      symptomCode: null,
      diagnosis: null,
      priority: defaultPriority('PREVENTIVE', 'PM'),
      workItemId: null,
      pmPlanId: plan.id,
      procedureVersionId,
    });
  }

  private async open(
    scope: PropertyScope,
    o: {
      type: WorkOrderRow['type'];
      source: WorkOrderRow['source'];
      assetId: string | null;
      locationId: string;
      symptomCode: string | null;
      diagnosis: string | null;
      priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      workItemId: string | null;
      pmPlanId?: string | null;
      procedureVersionId?: string | null;
    },
  ): Promise<WorkOrderRow> {
    const id = newId();
    const number = await this.repo.nextWorkOrderNumber(scope);
    let workItemId = o.workItemId;
    if (!workItemId) {
      const department = await this.org.getDepartment(
        scope.tenantId,
        scope.propertyId,
        ENG_DEPARTMENT,
      );
      const work = await this.ops.createWorkItem({
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        kind: ENG_WORK_ORDER_KIND,
        source: { module: ENG, entityType: 'work_order', entityId: id },
        title: { key: 'eng.work_order.title', params: { type: o.type, number } },
        priority: o.priority,
        locationId: o.locationId,
        departmentCode: department?.status === 'ACTIVE' ? ENG_DEPARTMENT : null,
      });
      workItemId = work.id;
    }
    const now = new Date();
    const row = (await this.repo.insertWorkOrder({
      id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      number,
      workItemId,
      type: o.type,
      source: o.source,
      assetId: o.assetId,
      locationId: o.locationId,
      reportedAt: now,
      symptomCode: o.symptomCode,
      diagnosis: o.diagnosis,
      pmPlanId: o.pmPlanId ?? null,
      procedureVersionId: o.procedureVersionId ?? null,
    }))!;
    await this.events.publish(WorkOrderCreated, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: ENG,
      aggregate: { type: 'work_order', id: row.id },
      payload: {
        work_order_id: row.id,
        work_item_id: workItemId,
        number,
        type: row.type,
        source: row.source,
        asset_id: row.assetId,
        location_id: row.locationId,
        symptom_code: row.symptomCode,
      },
    });
    await this.suggestWarranty(scope, row);
    await this.audit.record({
      action: 'eng.work_order.create',
      entityType: 'work_order',
      entityId: row.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      after: {
        number,
        type: row.type,
        source: row.source,
        asset_id: row.assetId,
        work_item_id: workItemId,
      },
    });
    return row;
  }

  /** A failure of equipment still under warranty becomes a suggestion for the supervisor (never sent by itself). */
  private async suggestWarranty(scope: PropertyScope, row: WorkOrderRow) {
    if (!row.assetId || (row.type !== 'CORRECTIVE' && row.type !== 'EMERGENCY')) return;
    const asset = await this.repo.asset(scope, row.assetId);
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: property?.timezone ?? 'UTC' }).format(
      row.reportedAt,
    );
    if (!asset || !underWarranty(asset.warrantyUntil, day)) return;
    await this.repo.insertWarrantyCase({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      workOrderId: row.id,
      assetId: asset.id,
      warrantyUntil: asset.warrantyUntil!,
    });
  }

  // ---- recording and closing ----

  update(scope: PropertyScope, id: string, input: z.infer<typeof updateWorkOrderSchema>) {
    return this.manage(scope, async () => {
      const current = await this.findForUpdate(scope, id);
      if (current.version !== input.version)
        throw AppError.conflict('eng.work_order.version_conflict');
      if (current.status === 'CANCELLED') throw AppError.conflict('eng.work_order.cancelled');
      return this.record(scope, current, input);
    });
  }

  /**
   * The engineer finishes the work: the coding is recorded and checked (corrective and emergency work must be fully
   * coded), then the work item's tasks are completed through the task lifecycle and the order closes with them.
   */
  complete(scope: PropertyScope, id: string, input: z.infer<typeof completeWorkOrderSchema>) {
    return this.manage(scope, async () => {
      const current = await this.findForUpdate(scope, id);
      if (current.status === 'DONE' || current.status === 'CANCELLED')
        throw AppError.conflict('eng.work_order.closed');
      const coded = await this.record(scope, current, {
        ...input,
        ...(current.downtimeStartedAt &&
        !current.downtimeEndedAt &&
        input.downtimeEndedAt === undefined
          ? { downtimeEndedAt: new Date() }
          : {}),
      });
      const missing = missingCoding(coded.type, coded);
      if (missing.length > 0)
        throw new AppError('eng.work_order.coding_missing', HttpStatus.UNPROCESSABLE_ENTITY, {
          fields: missing.join(', '),
        });
      const work = await this.ops.getWorkItem(scope.tenantId, coded.workItemId);
      for (const task of work?.tasks ?? []) {
        if (task.status === 'DONE' || task.status === 'CANCELLED') continue;
        if (task.status === 'NEW') await this.ops.actOnTask(scope, task.id, 'START');
        await this.ops.actOnTask(scope, task.id, 'COMPLETE');
      }
      return (await this.follow(scope, coded.workItemId)) ?? coded;
    });
  }

  private async record(
    scope: PropertyScope,
    current: WorkOrderRow,
    input: Omit<z.infer<typeof updateWorkOrderSchema>, 'version'>,
  ): Promise<WorkOrderRow> {
    const coding: Coding = {};
    for (const key of Object.keys(CODE_KIND) as Array<keyof Coding>)
      if (input[key] !== undefined) coding[key] = input[key];
    await this.checkCodes(scope, coding);
    if (input.assetId) await this.asset(scope, input.assetId);
    const started =
      input.downtimeStartedAt === undefined ? current.downtimeStartedAt : input.downtimeStartedAt;
    const ended =
      input.downtimeEndedAt === undefined ? current.downtimeEndedAt : input.downtimeEndedAt;
    if (started && ended && ended < started)
      throw AppError.conflict('eng.work_order.downtime_order');
    const row = await this.repo.updateWorkOrder(scope, current.id, {
      ...coding,
      ...(input.diagnosis !== undefined ? { diagnosis: input.diagnosis } : {}),
      ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
      ...(input.downtimeStartedAt !== undefined
        ? { downtimeStartedAt: input.downtimeStartedAt }
        : {}),
      ...(input.downtimeEndedAt !== undefined ? { downtimeEndedAt: input.downtimeEndedAt } : {}),
    });
    await this.audit.record({
      action: 'eng.work_order.record',
      entityType: 'work_order',
      entityId: row.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      before: codes(current),
      after: codes(row),
    });
    return row;
  }

  // ---- following the work (worker consumer, and inline after completing) ----

  async apply(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId || envelope.event_type !== WorkItemStatusChanged.type) return;
    const e = WorkItemStatusChanged.parse(envelope);
    await this.tx.run(() => this.follow({ tenantId, propertyId }, e.payload.work_item_id));
  }

  /** Moves the order to its work item's status; a closing order announces its taxonomy and downtime. */
  private async follow(scope: PropertyScope, workItemId: string): Promise<WorkOrderRow | null> {
    const order = await this.repo.workOrderOfWorkItem(scope, workItemId);
    if (!order) return null;
    const work = await this.ops.getWorkItem(scope.tenantId, workItemId);
    if (!work) return order;
    const next = statusFor(order.status, work.status);
    if (!next) return order;
    const row = await this.repo.updateWorkOrder(scope, order.id, {
      status: next,
      ...(next === 'DONE' || next === 'CANCELLED' ? { completedAt: new Date() } : {}),
    });
    if (next === 'DONE' || next === 'CANCELLED') {
      if (row.pmPlanId) await this.planDone(scope, row, next === 'DONE');
      if (next === 'DONE' && missingCoding(row.type, row).length > 0)
        this.logger.warn(
          { work_order_id: row.id },
          'work order closed without full failure coding',
        );
      await this.events.publish(WorkOrderClosed, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: ENG,
        aggregate: { type: 'work_order', id: row.id },
        payload: {
          work_order_id: row.id,
          asset_id: row.assetId,
          type: row.type,
          status: next,
          symptom_code: row.symptomCode,
          failure_mode_code: row.failureModeCode,
          cause_code: row.causeCode,
          resolution_code: row.resolutionCode,
          downtime_minutes: downtimeMinutes(row.downtimeStartedAt, row.downtimeEndedAt),
        },
      });
    }
    return row;
  }

  /** Finished preventive work moves its plan forward from today (and the meter's value); cancelled work frees it. */
  private async planDone(scope: PropertyScope, order: WorkOrderRow, done: boolean) {
    const plan = await this.repo.planForUpdate(scope, order.pmPlanId!);
    if (!plan || plan.openWorkOrderId !== order.id) return;
    if (!done) {
      await this.repo.updatePlan(scope, plan.id, { openWorkOrderId: null });
      return;
    }
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: property?.timezone ?? 'UTC',
    }).format(new Date());
    const meter =
      plan.trigger.kind === 'METER'
        ? await this.repo.meter(scope, plan.trigger.meterId)
        : undefined;
    await this.repo.updatePlan(scope, plan.id, {
      openWorkOrderId: null,
      lastDoneOn: today,
      ...(meter?.lastValue !== undefined && meter?.lastValue !== null
        ? { lastDoneValue: meter.lastValue }
        : {}),
    });
  }

  // ---- reading ----

  list(scope: PropertyScope, query: z.infer<typeof listWorkOrdersSchema>) {
    return this.read(scope, async () => {
      const orders = await this.repo.workOrdersOf(scope, {
        ...(query.status ? { statuses: query.status } : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
      });
      const label = await this.labels(scope);
      return orders.map((w) => ({
        ...w,
        ...label(w),
        downtimeMinutes: downtimeMinutes(w.downtimeStartedAt, w.downtimeEndedAt),
        codingMissing: missingCoding(w.type, w),
      }));
    });
  }

  /** Room number and asset number/name of an order, for the screens (one read of rooms and assets per list). */
  private async labels(scope: PropertyScope) {
    const rooms = new Map(
      (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [r.id, r.roomNumber]),
    );
    const assets = new Map((await this.repo.assetsOf(scope, {})).map((a) => [a.id, a]));
    return (w: { locationId: string; assetId: string | null }) => {
      const asset = w.assetId ? assets.get(w.assetId) : undefined;
      return {
        roomNumber: rooms.get(w.locationId) ?? null,
        assetNumber: asset?.assetNumber ?? null,
        assetName: asset?.name ?? null,
      };
    };
  }

  get(scope: PropertyScope, id: string) {
    return this.read(scope, async () => {
      const w = await this.find(scope, id);
      const work = await this.ops.getWorkItem(scope.tenantId, w.workItemId);
      return {
        ...w,
        ...(await this.labels(scope))(w),
        downtimeMinutes: downtimeMinutes(w.downtimeStartedAt, w.downtimeEndedAt),
        codingMissing: missingCoding(w.type, w),
        work: work
          ? { status: work.status, priority: work.priority, kind: work.kind, tasks: work.tasks }
          : null,
        parts: await this.repo.usagesOf(scope, w.id),
        warranty:
          (await this.repo.warrantyCasesOf(scope)).find((c) => c.workOrderId === w.id) ?? null,
      };
    });
  }

  // ---- parts ----

  createPart(scope: PropertyScope, input: z.infer<typeof createPartSchema>) {
    return this.gate.execute(
      { action: 'eng.parts.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const row = await this.repo.insertPart({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            ...input,
          });
          if (!row) throw AppError.conflict('eng.part.number_taken');
          await this.audit.record({
            action: 'eng.part.create',
            entityType: 'part',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { part_number: row.partNumber, on_hand: row.onHand },
          });
          return row;
        }),
    );
  }

  listParts(scope: PropertyScope) {
    return this.read(scope, async () =>
      (await this.repo.partsOf(scope)).map((p) => ({ ...p, lowStock: p.onHand <= p.reorderLevel })),
    );
  }

  receivePart(scope: PropertyScope, partId: string, input: z.infer<typeof receivePartSchema>) {
    return this.gate.execute(
      { action: 'eng.parts.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          await this.part(scope, partId);
          return this.repo.moveStock(scope, partId, input.quantity, {
            id: newId(),
            kind: 'RECEIPT',
            quantity: input.quantity,
            workOrderId: null,
            ...this.actorRef(),
            occurredAt: new Date(),
          });
        }),
    );
  }

  /** A part used on the work order comes off the shelf; there must be enough on hand. */
  usePart(scope: PropertyScope, workOrderId: string, input: z.infer<typeof usePartSchema>) {
    return this.manage(scope, async () => {
      const order = await this.findForUpdate(scope, workOrderId);
      if (order.status === 'CANCELLED') throw AppError.conflict('eng.work_order.cancelled');
      const part = await this.part(scope, input.partId);
      if (part.onHand < input.quantity)
        throw AppError.conflict('eng.part.insufficient_stock', { onHand: part.onHand });
      const row = await this.repo.moveStock(scope, part.id, -input.quantity, {
        id: newId(),
        kind: 'USAGE',
        quantity: input.quantity,
        workOrderId: order.id,
        ...this.actorRef(),
        occurredAt: new Date(),
      });
      return { ...row, lowStock: row.onHand <= row.reorderLevel };
    });
  }

  // ---- warranty ----

  warrantyCases(scope: PropertyScope) {
    return this.read(scope, () => this.repo.warrantyCasesOf(scope));
  }

  decideWarranty(scope: PropertyScope, id: string, input: z.infer<typeof warrantyDecisionSchema>) {
    return this.manage(scope, async () => {
      const current = isUuid(id) ? await this.repo.warrantyCaseForUpdate(scope, id) : undefined;
      if (!current) throw AppError.notFound('eng.warranty.not_found');
      if (current.version !== input.version)
        throw AppError.conflict('eng.warranty.version_conflict');
      const row = await this.repo.updateWarrantyCase(scope, id, {
        status: input.status,
        note: input.note ?? current.note,
      });
      await this.audit.record({
        action: 'eng.warranty.decide',
        entityType: 'warranty_case',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { status: current.status },
        after: { status: row.status },
      });
      return row;
    });
  }

  // ---- helpers ----

  private manage<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'eng.work_order.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.run(fn),
    );
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'eng.work_order.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }

  private actorRef() {
    const a = this.actors.require();
    return { actorType: a.type, actorId: isUuid(a.id) ? a.id : null };
  }

  private async asset(scope: PropertyScope, id: string) {
    const a = isUuid(id) ? await this.repo.asset(scope, id) : undefined;
    if (!a || a.propertyId !== scope.propertyId) throw AppError.notFound('eng.asset.not_found');
    return a;
  }

  private async part(scope: PropertyScope, id: string) {
    const p = isUuid(id) ? await this.repo.partForUpdate(scope, id) : undefined;
    if (!p) throw AppError.notFound('eng.part.not_found');
    return p;
  }

  private async find(scope: PropertyScope, id: string): Promise<WorkOrderRow> {
    const w = isUuid(id) ? await this.repo.workOrder(scope, id) : undefined;
    if (!w || w.propertyId !== scope.propertyId)
      throw AppError.notFound('eng.work_order.not_found');
    return w;
  }

  private async findForUpdate(scope: PropertyScope, id: string): Promise<WorkOrderRow> {
    const w = isUuid(id) ? await this.repo.workOrderForUpdate(scope, id) : undefined;
    if (!w || w.propertyId !== scope.propertyId)
      throw AppError.notFound('eng.work_order.not_found');
    return w;
  }

  /** Every code given must exist in the tenant's taxonomy for its kind (rule 16: never guess a code). */
  private async checkCodes(scope: PropertyScope, coding: Coding) {
    for (const [key, value] of Object.entries(coding) as Array<[keyof Coding, string | null]>) {
      if (!value) continue;
      const row = await this.repo.failureCode(scope, CODE_KIND[key], value);
      if (!row || !row.active)
        throw new AppError('eng.work_order.unknown_code', HttpStatus.UNPROCESSABLE_ENTITY, {
          code: value,
        });
    }
  }
}

function codes(w: WorkOrderRow) {
  return {
    symptom: w.symptomCode,
    failure_mode: w.failureModeCode,
    cause: w.causeCode,
    resolution: w.resolutionCode,
    asset_id: w.assetId,
    downtime_minutes: downtimeMinutes(w.downtimeStartedAt, w.downtimeEndedAt),
  };
}
