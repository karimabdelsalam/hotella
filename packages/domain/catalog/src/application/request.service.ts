import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ServiceRequestCreated, ServiceRequestRelated } from '@hotella/contracts-events';
import { GUEST_API, type GuestPrincipal, type GuestPublicApi } from '@hotella/domain-guest/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
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
import { addDays, localToUtc, wallClock } from '@hotella/platform-time';
import { canCancel } from '../domain/requests';
import {
  availabilityProblem,
  eligibilityProblem,
  FieldError,
  validateFields,
} from '../domain/rules';
import type {
  CreatedServiceRequest,
  CreateServiceRequestInput,
  ServiceRequestSummary,
} from '../public';
import { RequestRepositories } from '../infrastructure/request-repositories';
import type { RequestRow } from '../infrastructure/schema';
import { CATALOG, unprocessable } from './admin.service';
import { CatalogReader, type EffectiveService } from './catalog-reader';
import {
  RequestLifecycle,
  SERVICE_REQUEST_ENTITY as ENTITY,
  SERVICE_REQUEST_KIND,
} from './request-lifecycle';

export const guestRequestSchema = z.object({
  serviceCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  fields: z.record(z.string(), z.unknown()).default({}),
  requestedForAt: z.iso.datetime({ offset: true }).nullish(),
});
export const staffRequestSchema = guestRequestSchema.extend({
  /** Defaults to the stay's primary guest. */
  guestId: z.uuid().optional(),
});
export const cancelSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });
export const boardQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])).optional()),
  serviceCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
    .optional(),
  stayId: z.uuid().optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Service requests (Spec §7, §23; BUILD_PLAN §9.2). `create` is the one entrypoint: scope → eligibility → fields →
 * duplicates (related, not duplicated) → availability → request + work item in one transaction → audit → event. The
 * work is the operations engine's; the request follows it.
 */
@Injectable()
export class ServiceRequestService {
  constructor(
    private readonly repo: RequestRepositories,
    private readonly reader: CatalogReader,
    private readonly lifecycle: RequestLifecycle,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  // ---- creating ----

  /**
   * Guests act through their session (scope `SERVICE_REQUEST`, their own stay and person); everyone else through the
   * ActionGate with `request.create`.
   */
  create(input: CreateServiceRequestInput, guest?: GuestPrincipal): Promise<CreatedServiceRequest> {
    const actor = this.actors.require();
    const run = () => this.tx.run(() => this.createInTx(input, actor));
    if (actor.type === 'GUEST') {
      if (
        !guest ||
        guest.guestId !== input.guestId ||
        guest.stayId !== input.stayId ||
        guest.propertyId !== input.propertyId ||
        guest.tenantId !== input.tenantId
      )
        throw AppError.forbidden('platform.forbidden');
      if (!guest.scopes.includes('SERVICE_REQUEST'))
        throw AppError.forbidden('guest.session.scope_missing', { scope: 'SERVICE_REQUEST' });
      return run();
    }
    return this.gate.execute(
      { action: 'request.create', tenantId: input.tenantId, propertyId: input.propertyId },
      run,
    );
  }

  private async createInTx(
    input: CreateServiceRequestInput,
    actor: { type: string; id: string | null },
  ): Promise<CreatedServiceRequest> {
    const scope = { tenantId: input.tenantId, propertyId: input.propertyId };
    const now = new Date();
    const service = await this.reader.service(scope, input.serviceCode);
    const guestFacing = actor.type === 'GUEST' || input.source !== 'STAFF';
    if (!service || (guestFacing && !service.version.guestVisible))
      throw AppError.notFound('catalog.service.not_found');
    const standing = await this.reader.standingOf(
      input.tenantId,
      input.propertyId,
      input.stayId,
      input.guestId,
    );
    const problem = eligibilityProblem(service.eligibility, standing);
    if (problem) throw unprocessable(`catalog.request.${problem}`);
    const fields = this.fields(service, input.fields);
    const requestedFor = input.requestedForAt ? new Date(input.requestedForAt) : null;

    await this.repo.lockStayService(input.stayId, service.definition.id);
    const window = service.version.duplicateWindowMinutes;
    const open =
      window > 0
        ? await this.repo.openSince(
            scope,
            input.stayId,
            service.definition.id,
            new Date(now.getTime() - window * 60_000),
          )
        : undefined;
    if (open)
      return {
        request: summary(await this.relate(open, input, fields, actor, now)),
        related: true,
      };

    const property = await this.reader.property(scope);
    const day = propertyDay(now, property.timezone);
    const unavailable = availabilityProblem(service.availability, {
      now,
      requestedFor,
      timeZone: property.timezone,
      sameDayCount: await this.repo.countBetween(
        scope,
        input.stayId,
        service.definition.id,
        day.start,
        day.end,
      ),
    });
    if (unavailable) throw unprocessable(`catalog.request.${unavailable}`);

    const id = newId();
    await this.repo.insert({
      id,
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      definitionId: service.definition.id,
      serviceVersionId: service.version.id,
      serviceCode: service.definition.code,
      guestId: input.guestId,
      stayId: input.stayId,
      roomId: standing.roomId,
      conversationId: input.conversationId ?? null,
      fields,
      requestedForAt: requestedFor,
      locale: input.locale,
      source: input.source,
      createdByType: actor.type,
      createdById: isUuid(actor.id ?? '') ? actor.id : null,
    });
    const serviceName = await this.reader.serviceName(
      scope,
      service.version.id,
      property.defaultLocale,
      property,
    );
    const work = await this.ops.createWorkItem({
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      kind: SERVICE_REQUEST_KIND,
      source: { module: CATALOG, entityType: ENTITY, entityId: id },
      title: standing.roomNumber
        ? {
            key: 'catalog.request.work_title',
            params: { service: serviceName, room: standing.roomNumber },
          }
        : { key: 'catalog.request.work_title_no_room', params: { service: serviceName } },
      priority: service.version.priority,
      locationId: standing.roomId,
      departmentCode: service.version.departmentCode,
      serviceCode: service.definition.code,
      stayId: input.stayId,
      guestId: input.guestId,
      workflowCode: service.version.workflowCode,
    });
    const request = await this.repo.update(scope, id, { workItemId: work.id });
    await this.repo.insertEvent({
      id: newId(),
      tenantId: input.tenantId,
      requestId: id,
      type: 'CREATED',
      toStatus: 'OPEN',
      actorType: actor.type,
      actorId: isUuid(actor.id ?? '') ? actor.id : null,
      source: input.source,
      occurredAt: now,
    });
    await this.audit.record({
      action: 'catalog.request.create',
      entityType: ENTITY,
      entityId: id,
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      after: {
        service: service.definition.code,
        version: service.version.versionNo,
        source: input.source,
        stay_id: input.stayId,
        work_item_id: work.id,
      },
    });
    await this.events.publish(ServiceRequestCreated, {
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      source: CATALOG,
      aggregate: { type: ENTITY, id },
      payload: {
        request_id: id,
        service_code: service.definition.code,
        service_version_id: service.version.id,
        stay_id: input.stayId,
        guest_id: input.guestId,
        room_id: standing.roomId,
        work_item_id: work.id,
        source: input.source,
      },
    });
    return { request: summary(request), related: false };
  }

  private fields(service: EffectiveService, values: Readonly<Record<string, unknown>>) {
    try {
      return validateFields(service.fields, values);
    } catch (e) {
      if (e instanceof FieldError)
        throw new AppError('catalog.request.field_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
          field: e.field,
          problem: e.problem,
        });
      throw e;
    }
  }

  /** The same stay asked again while the first ask is open: one request, the ask kept in its history (Spec §23). */
  private async relate(
    open: RequestRow,
    input: CreateServiceRequestInput,
    fields: Record<string, unknown>,
    actor: { type: string; id: string | null },
    now: Date,
  ): Promise<RequestRow> {
    const scope = { tenantId: open.tenantId };
    const updated = await this.repo.update(scope, open.id, {
      relatedCount: open.relatedCount + 1,
      lastRelatedAt: now,
    });
    await this.repo.insertEvent({
      id: newId(),
      tenantId: open.tenantId,
      requestId: open.id,
      type: 'RELATED',
      actorType: actor.type,
      actorId: isUuid(actor.id ?? '') ? actor.id : null,
      source: input.source,
      fields,
      occurredAt: now,
    });
    await this.audit.record({
      action: 'catalog.request.relate',
      entityType: ENTITY,
      entityId: open.id,
      tenantId: open.tenantId,
      propertyId: open.propertyId,
      after: { related_count: updated.relatedCount, source: input.source },
    });
    await this.events.publish(ServiceRequestRelated, {
      tenantId: open.tenantId,
      propertyId: open.propertyId,
      source: CATALOG,
      aggregate: { type: ENTITY, id: open.id },
      payload: {
        request_id: open.id,
        service_code: open.serviceCode,
        stay_id: open.stayId,
        guest_id: input.guestId,
        related_count: updated.relatedCount,
        source: input.source,
      },
    });
    return updated;
  }

  // ---- cancelling ----

  /** A guest cancels their own open request. */
  cancelByGuest(guest: GuestPrincipal, id: string) {
    return this.tx.run(async () => {
      const request = await this.findForUpdate({ tenantId: guest.tenantId }, id);
      if (request.stayId !== guest.stayId || request.guestId !== guest.guestId)
        throw AppError.notFound('catalog.request.not_found');
      return summary(await this.cancel(request, 'GUEST', null));
    });
  }

  /** Staff cancel any open or started request of their property (`request.manage`), with a reason. */
  cancelByStaff(scope: PropertyScope, id: string, reason: string | null) {
    return this.gate.execute(
      { action: 'request.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const request = await this.findForUpdate(scope, id);
          if (request.propertyId !== scope.propertyId)
            throw AppError.notFound('catalog.request.not_found');
          return summary(await this.cancel(request, 'STAFF', reason));
        }),
    );
  }

  private async cancel(request: RequestRow, by: 'GUEST' | 'STAFF', reason: string | null) {
    if (!canCancel(request.status, by)) throw AppError.conflict('catalog.request.cannot_cancel');
    const actor = this.actors.require();
    const updated = await this.lifecycle.move(
      request,
      'CANCELLED',
      { type: actor.type, id: actor.id },
      reason,
    );
    if (request.workItemId)
      await this.ops.cancelWorkItem(request.tenantId, request.workItemId, 'REQUEST_CANCELLED');
    await this.audit.record({
      action: 'catalog.request.cancel',
      entityType: ENTITY,
      entityId: request.id,
      tenantId: request.tenantId,
      propertyId: request.propertyId,
      before: { status: request.status },
      after: { status: 'CANCELLED', by },
      reason,
    });
    return updated;
  }

  // ---- reading ----

  /** The guest's requests: the primary guest sees the stay's, a companion their own. */
  guestRequests(guest: GuestPrincipal, locale: string) {
    return this.tx.read(async () => {
      if (!guest.stayId) return [];
      const stay = await this.guests.getStay(guest.tenantId, guest.stayId);
      const all = stay?.primaryGuestId === guest.guestId;
      const rows = await this.repo.ofStay(
        { tenantId: guest.tenantId },
        guest.stayId,
        all ? null : guest.guestId,
      );
      return this.views({ tenantId: guest.tenantId, propertyId: guest.propertyId }, rows, locale);
    });
  }

  guestRequest(guest: GuestPrincipal, id: string, locale: string) {
    return this.tx.read(async () => {
      const request = isUuid(id)
        ? await this.repo.get({ tenantId: guest.tenantId }, id)
        : undefined;
      const stay = guest.stayId ? await this.guests.getStay(guest.tenantId, guest.stayId) : null;
      if (
        !request ||
        !stay ||
        request.stayId !== stay.id ||
        (request.guestId !== guest.guestId && stay.primaryGuestId !== guest.guestId)
      )
        throw AppError.notFound('catalog.request.not_found');
      return (
        await this.views(
          { tenantId: guest.tenantId, propertyId: guest.propertyId },
          [request],
          locale,
        )
      )[0]!;
    });
  }

  board(scope: PropertyScope, filter: z.infer<typeof boardQuerySchema>, locale: string) {
    return this.gate.execute(
      { action: 'request.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const rows = await this.repo.board(scope, filter);
          const views = await this.views(scope, rows, locale);
          const rooms = new Map(
            (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [
              r.id,
              r.roomNumber,
            ]),
          );
          const names = new Map<string, string>();
          for (const stayId of new Set(rows.map((r) => r.stayId)))
            for (const m of await this.guests.stayParty(scope.tenantId, stayId))
              names.set(m.guestId, [m.givenName, m.familyName].filter(Boolean).join(' '));
          return views.map((v) => ({
            ...v,
            roomNumber: v.roomId ? (rooms.get(v.roomId) ?? null) : null,
            guestName: names.get(v.guestId) ?? null,
          }));
        }),
    );
  }

  detail(scope: PropertyScope, id: string, locale: string) {
    return this.gate.execute(
      { action: 'request.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const request = isUuid(id) ? await this.repo.get(scope, id) : undefined;
          if (!request || request.propertyId !== scope.propertyId)
            throw AppError.notFound('catalog.request.not_found');
          const [view] = await this.views(scope, [request], locale);
          const history = await this.repo.eventsOf(scope, id);
          return {
            ...view!,
            fields: request.fields,
            workItem: request.workItemId
              ? await this.ops.getWorkItem(scope.tenantId, request.workItemId)
              : null,
            history: history.map((e) => ({
              type: e.type,
              from: e.fromStatus,
              to: e.toStatus,
              actorType: e.actorType,
              actorId: e.actorId,
              source: e.source,
              fields: e.fields,
              reason: e.reason,
              at: e.occurredAt,
            })),
          };
        }),
    );
  }

  /** Staff ask on a guest's behalf (front desk took a call); the same entrypoint with source STAFF. */
  async createForGuest(
    scope: PropertyScope,
    stayId: string,
    body: z.infer<typeof staffRequestSchema>,
    locale: string,
  ) {
    const stay = isUuid(stayId) ? await this.guests.getStay(scope.tenantId, stayId) : null;
    if (!stay || stay.propertyId !== scope.propertyId)
      throw AppError.notFound('guest.stay.not_found');
    return this.create({
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      stayId,
      guestId: body.guestId ?? stay.primaryGuestId,
      serviceCode: body.serviceCode,
      fields: body.fields,
      requestedForAt: body.requestedForAt ?? null,
      locale,
      source: 'STAFF',
    });
  }

  private async views(scope: PropertyScope, rows: readonly RequestRow[], locale: string) {
    const property = await this.reader.property(scope);
    const names = new Map<string, string>();
    for (const versionId of new Set(rows.map((r) => r.serviceVersionId)))
      names.set(versionId, await this.reader.serviceName(scope, versionId, locale, property));
    return rows.map((r) => ({
      ...summary(r),
      serviceName: names.get(r.serviceVersionId) ?? r.serviceCode,
    }));
  }

  private async findForUpdate(scope: TenantScope, id: string): Promise<RequestRow> {
    const request = isUuid(id) ? await this.repo.getForUpdate(scope, id) : undefined;
    if (!request) throw AppError.notFound('catalog.request.not_found');
    return request;
  }
}

/** Start and end (exclusive) of the property's calendar day containing `at`. */
function propertyDay(at: Date, timeZone: string): { start: Date; end: Date } {
  const w = wallClock(at, timeZone);
  const today = { year: w.year, month: w.month, day: w.day };
  return {
    start: localToUtc({ ...today, hour: 0, minute: 0 }, timeZone),
    end: localToUtc({ ...addDays(today, 1), hour: 0, minute: 0 }, timeZone),
  };
}

export function summary(r: RequestRow): ServiceRequestSummary {
  return {
    id: r.id,
    propertyId: r.propertyId,
    serviceCode: r.serviceCode,
    serviceVersionId: r.serviceVersionId,
    stayId: r.stayId,
    guestId: r.guestId,
    roomId: r.roomId,
    workItemId: r.workItemId,
    status: r.status,
    requestedForAt: r.requestedForAt?.toISOString() ?? null,
    locale: r.locale,
    source: r.source,
    relatedCount: r.relatedCount,
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
  };
}
