import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  type EventEnvelope,
  GuestCheckedOut,
  HkJobCreated,
  HkJobStatusChanged,
  StayRoomChanged,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '@hotella/domain-integrations/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
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
import { SettingsReader } from '@hotella/platform-settings';
import {
  CLEANING_TYPES,
  type CleaningType,
  jobStatusFor,
  type JobStatus,
  localDay,
  localHour,
  resolveCredits,
} from '../domain/jobs';
import { type BalancerJob, proposeAssignments } from '../domain/balancer';
import { HK_ARRIVAL_CLEAN, HK_INSPECTION_REQUIRED, HK_STAYOVER_HOUR } from '../domain/settings';
import { HousekeepingRepositories } from '../infrastructure/repositories';
import type { JobRow } from '../infrastructure/schema';
import { RoomStateService } from './room-state.service';

export const HK_JOB_KIND = 'HK_JOB';
const HK = 'hk';
const isoDay = z.iso.date();

export const createJobSchema = z.object({
  roomId: z.uuid(),
  cleaningType: z.enum(CLEANING_TYPES),
  /** Property-local day; today when omitted. */
  scheduledFor: isoDay.optional(),
  /** Defaults by type: HIGH for VIP set-ups, NORMAL otherwise. */
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
});
export const listJobsSchema = z.object({
  day: isoDay.optional(),
  status: z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(
      z.array(
        z.enum([
          'OPEN',
          'IN_PROGRESS',
          'DONE',
          'INSPECTED',
          'FAILED_INSPECTION',
          'SKIPPED',
          'CANCELLED',
        ]),
      ),
    )
    .optional(),
});
export const proposalSchema = z.object({
  day: isoDay.optional(),
  attendantIds: z.array(z.uuid()).min(1).max(50),
});
export const applyAssignmentsSchema = z.object({
  assignments: z
    .array(z.object({ jobId: z.uuid(), userId: z.uuid() }))
    .min(1)
    .max(500),
});
export const skipSchema = z.object({ reason: z.string().trim().min(1).max(200) });
export const inspectSchema = z.object({
  result: z.enum(['PASS', 'FAIL']),
  notes: z.string().trim().max(1000).optional(),
});
export const creditRuleSchema = z.object({
  cleaningType: z.enum(CLEANING_TYPES),
  roomTypeId: z.uuid().nullable().default(null),
  credits: z.number().min(0).max(20).multipleOf(0.05),
});

interface Actor {
  readonly type: string;
  readonly id: string | null;
}
const SYSTEM: Actor = { type: 'SYSTEM', id: null };
/** An arrival clean is a final check of a room that is already clean (dirty rooms have their CHECKOUT clean). */
const ARRIVAL_READY = new Set(['CLEAN', 'INSPECTED']);

/**
 * Cleaning jobs (Spec §9.1–§9.2, BUILD_PLAN 7.2) on the operations engine: a job is an `HK_JOB` work item for the
 * Housekeeping department (assignment, SLA and history live there) and follows its status; the room's housekeeping
 * state moves with the job (CLEANING → CLEAN, or INSPECTING when the property inspects). Check-outs and the daily
 * stayover sweep create jobs; a failed inspection creates a touch-up.
 */
@Injectable()
export class JobService {
  static readonly consumes = [GuestCheckedOut, StayRoomChanged, WorkItemStatusChanged];

  constructor(
    private readonly repo: HousekeepingRepositories,
    private readonly rooms: RoomStateService,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly gate: ActionGate,
    private readonly settings: SettingsReader,
    private readonly ctx: RequestContext,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---- creating ----

  /** Creates a job and its work item (inside the caller's transaction); a generated duplicate returns null. */
  async create(
    scope: PropertyScope,
    input: {
      roomId: string;
      cleaningType: CleaningType;
      scheduledFor: string;
      origin: 'GENERATED' | 'STAFF' | 'INSPECTION';
      stayId?: string | null;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    },
  ): Promise<JobRow | null> {
    const room = await this.org.getRoom(scope.tenantId, scope.propertyId, input.roomId);
    if (!room) throw AppError.notFound('hk.room.not_found');
    const credits = resolveCredits(
      (await this.repo.creditRules(scope)).map((r) => ({
        cleaningType: r.cleaningType,
        roomTypeId: r.roomTypeId,
        credits: r.credits,
      })),
      input.cleaningType,
      room.roomTypeId,
    );
    const job = await this.repo.insertJob({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      roomId: input.roomId,
      stayId: input.stayId ?? null,
      cleaningType: input.cleaningType,
      origin: input.origin,
      credits,
      scheduledFor: input.scheduledFor,
    });
    if (!job) return null;
    const work = await this.ops.createWorkItem({
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      kind: HK_JOB_KIND,
      source: { module: HK, entityType: 'hk_job', entityId: job.id },
      title: { key: 'hk.job.title', params: { type: input.cleaningType, room: room.roomNumber } },
      priority: input.priority ?? (input.cleaningType === 'VIP' ? 'HIGH' : 'NORMAL'),
      locationId: input.roomId,
      departmentCode: 'HK',
      stayId: input.stayId ?? null,
    });
    const linked = await this.repo.updateJob(scope, job.id, { workItemId: work.id });
    await this.events.publish(HkJobCreated, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: HK,
      aggregate: { type: 'hk_job', id: job.id },
      payload: {
        job_id: job.id,
        room_id: job.roomId,
        work_item_id: work.id,
        cleaning_type: job.cleaningType,
        origin: job.origin,
        credits: job.credits,
        scheduled_for: job.scheduledFor,
      },
    });
    return linked;
  }

  /** Staff create a job (`hk.job.manage`), e.g. a deep clean or a VIP set-up. */
  createByStaff(scope: PropertyScope, input: z.infer<typeof createJobSchema>) {
    return this.gate.execute(
      { action: 'hk.job.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const job = await this.create(scope, {
            roomId: input.roomId,
            cleaningType: input.cleaningType,
            scheduledFor: input.scheduledFor ?? (await this.today(scope)),
            origin: 'STAFF',
            ...(input.priority ? { priority: input.priority } : {}),
          });
          await this.audit.record({
            action: 'hk.job.create',
            entityType: 'hk_job',
            entityId: job!.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: {
              room_id: job!.roomId,
              cleaning_type: job!.cleaningType,
              credits: job!.credits,
            },
          });
          return job!;
        }),
    );
  }

  // ---- following the PMS and the work (worker consumers) ----

  async apply(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId) return;
    const scope = { tenantId, propertyId };
    switch (envelope.event_type) {
      case GuestCheckedOut.type: {
        const e = GuestCheckedOut.parse(envelope);
        if (e.payload.room)
          await this.checkout(scope, e.payload.room.room_id, new Date(envelope.occurred_at));
        return;
      }
      case StayRoomChanged.type: {
        const e = StayRoomChanged.parse(envelope);
        if (e.payload.from_room)
          await this.checkout(scope, e.payload.from_room.room_id, new Date(envelope.occurred_at));
        return;
      }
      case WorkItemStatusChanged.type: {
        const e = WorkItemStatusChanged.parse(envelope);
        if (e.payload.kind === HK_JOB_KIND) await this.follow(scope, e.payload.work_item_id);
        return;
      }
    }
  }

  /** A room left by a guest gets its CHECKOUT clean for the property-local day. */
  private async checkout(scope: PropertyScope, roomId: string, at: Date): Promise<void> {
    await this.tx.run(async () => {
      const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
      if (!property) return;
      await this.create(scope, {
        roomId,
        cleaningType: 'CHECKOUT',
        scheduledFor: localDay(at, property.timezone),
        origin: 'GENERATED',
      });
    });
  }

  /** The job follows its work item's current status (late or repeated events cannot move it back). */
  async follow(scope: PropertyScope, workItemId: string): Promise<void> {
    // Assigned inside the transaction callback (a type assertion keeps TypeScript from narrowing it to null).
    let reached = null as { roomId: string; jobId: string; status: 'CLEAN' } | null;
    await this.tx.run(async () => {
      const job = await this.repo.jobOfWorkItem(scope, workItemId);
      const work = await this.ops.getWorkItem(scope.tenantId, workItemId);
      if (!job || !work) return;
      const next = jobStatusFor(job.status, work.status);
      if (!next) return;
      const now = new Date();
      await this.repo.updateJob(scope, job.id, {
        status: next,
        ...(next === 'IN_PROGRESS' ? { startedAt: now } : {}),
        ...(next === 'DONE' ? { completedAt: now, startedAt: job.startedAt ?? now } : {}),
      });
      await this.statusChanged(scope, job, next);
      const room = await this.repo.stateForUpdate(scope, job.roomId);
      if (
        next === 'IN_PROGRESS' &&
        (room.housekeeping === 'DIRTY' || room.housekeeping === 'PICKUP')
      )
        await this.rooms.move(scope, room, { housekeeping: 'CLEANING' }, 'JOB', SYSTEM, now, {
          jobId: job.id,
        });
      if (next === 'DONE') {
        const inspect = await this.settings.value(HK_INSPECTION_REQUIRED, scope);
        await this.rooms.move(
          scope,
          room,
          { housekeeping: inspect ? 'INSPECTING' : 'CLEAN' },
          'JOB',
          SYSTEM,
          now,
          { jobId: job.id },
        );
        if (!inspect) reached = { roomId: job.roomId, jobId: job.id, status: 'CLEAN' };
      }
    });
    if (reached) await this.tellPms(scope, reached.roomId, reached.jobId, reached.status);
  }

  /** Staff skip an open job with a reason (DND all day, guest declined service); its work is withdrawn. */
  skip(scope: PropertyScope, jobId: string, reason: string, actor: Actor) {
    return this.gate.execute(
      { action: 'hk.job.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const job = await this.find(scope, jobId);
          if (job.status !== 'OPEN') throw AppError.conflict('hk.job.not_open');
          const updated = await this.repo.updateJob(scope, job.id, {
            status: 'SKIPPED',
            skipReason: reason,
          });
          if (job.workItemId)
            await this.ops.cancelWorkItem(scope.tenantId, job.workItemId, 'HK_JOB_SKIPPED');
          await this.statusChanged(scope, job, 'SKIPPED');
          await this.audit.record({
            action: 'hk.job.skip',
            entityType: 'hk_job',
            entityId: job.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            actor: { type: actor.type as 'USER', id: actor.id },
            reason,
            before: { status: job.status },
            after: { status: 'SKIPPED' },
          });
          return updated;
        }),
    );
  }

  // ---- inspection (minimal hook before the Phase 9 engine) ----

  async inspect(
    scope: PropertyScope,
    jobId: string,
    input: z.infer<typeof inspectSchema>,
    actor: Actor,
  ) {
    let passedJob = null as { roomId: string; jobId: string } | null;
    const result = await this.gate.execute(
      { action: 'hk.inspect', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const job = await this.find(scope, jobId);
          const room = await this.repo.stateForUpdate(scope, job.roomId);
          if (job.status !== 'DONE' || room.housekeeping !== 'INSPECTING')
            throw AppError.conflict('hk.job.not_awaiting_inspection');
          const now = new Date();
          await this.repo.insertInspection({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            jobId: job.id,
            roomId: job.roomId,
            result: input.result,
            notes: input.notes ?? null,
            inspectorId: actor.id && isUuid(actor.id) ? actor.id : null,
            inspectedAt: now,
          });
          const passed = input.result === 'PASS';
          const updated = await this.repo.updateJob(scope, job.id, {
            status: passed ? 'INSPECTED' : 'FAILED_INSPECTION',
            inspectedAt: now,
          });
          await this.statusChanged(scope, job, updated.status);
          await this.rooms.move(
            scope,
            room,
            { housekeeping: passed ? 'INSPECTED' : 'DIRTY' },
            'INSPECTION',
            actor,
            now,
            { jobId: job.id },
          );
          const touchUp = passed
            ? null
            : await this.create(scope, {
                roomId: job.roomId,
                cleaningType: 'TOUCH_UP',
                scheduledFor: job.scheduledFor,
                origin: 'INSPECTION',
                stayId: job.stayId,
                priority: 'HIGH',
              });
          await this.audit.record({
            action: `hk.inspection.${passed ? 'pass' : 'fail'}`,
            entityType: 'hk_job',
            entityId: job.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            actor: { type: actor.type as 'USER', id: actor.id },
            ...(input.notes ? { reason: input.notes } : {}),
            after: { result: input.result, touch_up_job_id: touchUp?.id ?? null },
          });
          if (passed) passedJob = { roomId: job.roomId, jobId: job.id };
          return { job: updated, touchUp };
        }),
    );
    if (passedJob) await this.tellPms(scope, passedJob.roomId, passedJob.jobId, 'INSPECTED');
    return result;
  }

  // ---- the daily sweep (worker, hourly) ----

  /**
   * Once a property's local hour passed `hk.stayover.hour`: the day's STAYOVER clean for each occupied room and, when
   * `hk.arrival.clean` is on, an ARRIVAL clean for each vacant clean room an expected guest is assigned to today. Both
   * are idempotent per room, type and day, so the hourly run creates each once.
   */
  async generateDaily(now = new Date()): Promise<number> {
    const tracked = await this.tx.read(() => this.repo.trackedRooms());
    const byProperty = new Map<
      string,
      { tenantId: string; propertyId: string; rooms: typeof tracked }
    >();
    for (const r of tracked) {
      const key = `${r.tenantId}|${r.propertyId}`;
      const entry = byProperty.get(key) ?? {
        tenantId: r.tenantId,
        propertyId: r.propertyId,
        rooms: [],
      };
      entry.rooms.push(r);
      byProperty.set(key, entry);
    }
    let created = 0;
    for (const p of byProperty.values()) {
      const scope = { tenantId: p.tenantId, propertyId: p.propertyId };
      // One property's failure (e.g. no Housekeeping department yet) does not hold the others back.
      try {
        created += await this.ctx.run({ tenant_id: p.tenantId, property_id: p.propertyId }, () =>
          this.dailyFor(scope, p.rooms, now),
        );
      } catch (err) {
        this.logger.warn(
          { err, tenant_id: p.tenantId, property_id: p.propertyId },
          'daily cleans not created',
        );
      }
    }
    if (created > 0) this.logger.info({ created }, 'daily cleans created');
    return created;
  }

  private async dailyFor(
    scope: PropertyScope,
    rooms: ReadonlyArray<{ roomId: string; occupancy: string; housekeeping: string }>,
    now: Date,
  ): Promise<number> {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    if (!property) return 0;
    if (localHour(now, property.timezone) < (await this.settings.value(HK_STAYOVER_HOUR, scope)))
      return 0;
    const day = localDay(now, property.timezone);
    const wanted: Array<{ roomId: string; type: CleaningType; stayId: string | null }> = rooms
      .filter((r) => r.occupancy === 'OCCUPIED')
      .map((r) => ({ roomId: r.roomId, type: 'STAYOVER', stayId: null }));
    if (await this.settings.value(HK_ARRIVAL_CLEAN, scope)) {
      const byRoom = new Map(rooms.map((r) => [r.roomId, r]));
      for (const stay of await this.guests.expectedArrivals(
        scope.tenantId,
        scope.propertyId,
        day,
      )) {
        const room = stay.currentRoomId ? byRoom.get(stay.currentRoomId) : undefined;
        if (room && room.occupancy === 'VACANT' && ARRIVAL_READY.has(room.housekeeping))
          wanted.push({ roomId: room.roomId, type: 'ARRIVAL', stayId: stay.id });
      }
    }
    return this.tx.run(async () => {
      let n = 0;
      for (const w of wanted) {
        const job = await this.create(scope, {
          roomId: w.roomId,
          cleaningType: w.type,
          scheduledFor: day,
          origin: 'GENERATED',
          stayId: w.stayId,
        });
        if (job) n++;
      }
      return n;
    });
  }

  // ---- reading and configuration ----

  /**
   * The day's jobs with their room, task, assignee and the room's signals; open jobs of rooms asking to be made up
   * come first, then by room number (`hk.board.read`).
   */
  list(scope: PropertyScope, query: z.infer<typeof listJobsSchema>) {
    return this.gate.execute(
      { action: 'hk.board.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(async () => this.views(scope, query)),
    );
  }

  private async views(scope: PropertyScope, query: z.infer<typeof listJobsSchema>) {
    const day = query.day ?? (await this.today(scope));
    const rows = await this.repo.jobsOf(scope, {
      day,
      ...(query.status ? { statuses: query.status } : {}),
    });
    const rooms = new Map(
      (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [r.id, r]),
    );
    const signals = await this.repo.openSignals(scope);
    const has = (roomId: string, signal: string) =>
      signals.some((x) => x.roomId === roomId && x.signal === signal);
    const view = async (j: JobRow) => {
      const work = j.workItemId ? await this.ops.getWorkItem(scope.tenantId, j.workItemId) : null;
      const task = work?.tasks[0] ?? null;
      const room = rooms.get(j.roomId);
      return {
        ...j,
        roomNumber: room?.roomNumber ?? null,
        floorLabel: room?.floorLabel ?? null,
        taskId: task?.id ?? null,
        assignee: task?.assignee ?? null,
        priority: work?.priority ?? null,
        makeUpRequested: has(j.roomId, 'MAKE_UP_ROOM'),
        doNotDisturb: has(j.roomId, 'DND') || has(j.roomId, 'PRIVACY'),
      };
    };
    // One query at a time on the transaction's connection.
    const out: Array<Awaited<ReturnType<typeof view>>> = [];
    for (const j of rows) out.push(await view(j));
    const rank = (v: (typeof out)[number]) => (v.status === 'OPEN' && v.makeUpRequested ? 0 : 1);
    return out.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.roomNumber ?? '').localeCompare(b.roomNumber ?? '', 'en', { numeric: true }),
    );
  }

  // ---- assignment proposal (BUILD_PLAN 7.B): code proposes, a person applies ----

  /** The day's open jobs balanced across the chosen attendants by credits, floors kept together (`hk.job.manage`). */
  propose(scope: PropertyScope, input: z.infer<typeof proposalSchema>) {
    return this.gate.execute(
      { action: 'hk.job.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const open = await this.views(scope, {
            ...(input.day ? { day: input.day } : {}),
            status: ['OPEN'],
          });
          const jobs: BalancerJob[] = open.map((j) => ({
            jobId: j.id,
            roomNumber: j.roomNumber ?? '',
            floor: j.floorLabel,
            credits: j.credits,
          }));
          const plan = proposeAssignments(jobs, input.attendantIds);
          const totalCredits = Math.round(jobs.reduce((t, j) => t + j.credits, 0) * 100) / 100;
          return {
            day: open[0]?.scheduledFor ?? input.day ?? (await this.today(scope)),
            totalCredits,
            plan,
          };
        }),
    );
  }

  /**
   * Applies a (possibly edited) proposal: each job's task is assigned to the attendant through the operations engine
   * (`task.assign` is checked there; assignment history kept). All or nothing.
   */
  applyAssignments(scope: PropertyScope, input: z.infer<typeof applyAssignmentsSchema>) {
    return this.gate.execute(
      { action: 'hk.job.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          for (const a of input.assignments) {
            const job = await this.find(scope, a.jobId);
            if (job.status !== 'OPEN') throw AppError.conflict('hk.job.not_open');
            const work = job.workItemId
              ? await this.ops.getWorkItem(scope.tenantId, job.workItemId)
              : null;
            const task = work?.tasks[0];
            if (!task) throw AppError.conflict('hk.job.not_open');
            await this.ops.assignTask(
              scope,
              task.id,
              { type: 'USER', userId: a.userId },
              'Housekeeping assignment',
            );
          }
          await this.audit.record({
            action: 'hk.assignment.apply',
            entityType: 'property',
            entityId: scope.propertyId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { assignments: input.assignments.length },
          });
          return { assigned: input.assignments.length };
        }),
    );
  }

  creditRules(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'hk.board.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.repo.creditRules(scope)),
    );
  }

  putCreditRule(scope: PropertyScope, input: z.infer<typeof creditRuleSchema>) {
    return this.gate.execute(
      { action: 'hk.config.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const rule = await this.repo.putCreditRule(scope, { id: newId(), ...input });
          await this.audit.record({
            action: 'hk.credit_rule.put',
            entityType: 'hk_credit_rule',
            entityId: rule.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: {
              cleaning_type: rule.cleaningType,
              room_type_id: rule.roomTypeId,
              credits: rule.credits,
            },
          });
          return rule;
        }),
    );
  }

  // ---- helpers ----

  private async find(scope: PropertyScope, jobId: string): Promise<JobRow> {
    const job = isUuid(jobId) ? await this.repo.jobForUpdate(scope, jobId) : undefined;
    if (!job || job.propertyId !== scope.propertyId) throw AppError.notFound('hk.job.not_found');
    return job;
  }

  private async today(scope: PropertyScope): Promise<string> {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    return localDay(new Date(), property?.timezone ?? 'UTC');
  }

  private async statusChanged(
    scope: TenantScope & { propertyId: string },
    job: JobRow,
    to: JobStatus,
  ) {
    await this.events.publish(HkJobStatusChanged, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: HK,
      aggregate: { type: 'hk_job', id: job.id },
      payload: { job_id: job.id, room_id: job.roomId, from: job.status, to },
    });
  }

  /**
   * Tells the PMS the room's new status when an active integration of the property may write room statuses (rule 19:
   * otherwise the status stays internal). Best effort and outside the job's transaction: a refused command never undoes
   * the cleaning.
   */
  private async tellPms(
    scope: PropertyScope,
    roomId: string,
    jobId: string,
    status: 'CLEAN' | 'INSPECTED',
  ) {
    try {
      const instances = (
        await this.integrations.listInstances(scope.tenantId, scope.propertyId)
      ).filter(
        (i) => i.status === 'ACTIVE' && i.effectiveCapabilities.includes('ROOM_STATUS_WRITE'),
      );
      if (instances.length === 0) return;
      const room = await this.org.getRoom(scope.tenantId, scope.propertyId, roomId);
      if (!room) return;
      for (const instance of instances)
        await this.integrations.requestCommand({
          tenantId: scope.tenantId,
          integrationInstanceId: instance.id,
          commandType: 'SET_ROOM_STATUS',
          payload: { room_number: room.roomNumber, status },
          // One write per job outcome: a repeated work item event does not send it twice.
          idempotencyKey: `hk-room-status-${jobId}-${status}`,
          requestedBy: { type: 'SYSTEM', id: null },
          correlationId: this.ctx.correlationId,
        });
    } catch (e) {
      this.logger.warn({ err: e, room_id: roomId }, 'room status not sent to the PMS');
    }
  }
}
