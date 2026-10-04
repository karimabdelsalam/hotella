import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RoomRestrictionChanged } from '@hotella/contracts-events';
import { PMS_API, type PmsPublicApi } from '@hotella/domain-integrations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { EngineeringRepositories } from '../infrastructure/repositories';
import type { RoomRestrictionRow } from '../infrastructure/schema';

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const createRestrictionSchema = z.object({
  roomId: z.uuid(),
  kind: z.enum(['OOO', 'OOS', 'BLOCKED_OPERATIONALLY']),
  reason: z.string().trim().min(1).max(300),
  startsAt: instant.optional(),
  endsAt: instant.optional(),
  workOrderId: z.uuid().optional(),
});
export const listRestrictionsSchema = z.object({
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(true),
});

/**
 * Room restrictions (Spec §10.10): a room engineering takes out of use. One open restriction per room, history kept.
 * When the property's PMS instance may write out-of-order statuses (`OOO_WRITE`), the PMS is told (rule 19: never
 * otherwise); the write is best effort after the transaction and its outcome is kept on the restriction.
 */
@Injectable()
export class RestrictionService {
  constructor(
    private readonly repo: EngineeringRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    private readonly ctx: RequestContext,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(PMS_API) private readonly pms: PmsPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async restrict(scope: PropertyScope, input: z.infer<typeof createRestrictionSchema>) {
    const row = await this.gate.execute(
      { action: 'eng.restriction.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          if (!(await this.org.getRoom(scope.tenantId, scope.propertyId, input.roomId)))
            throw AppError.notFound('org.room.not_found');
          if (input.workOrderId && !(await this.repo.workOrder(scope, input.workOrderId)))
            throw AppError.notFound('eng.work_order.not_found');
          if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt)
            throw AppError.conflict('eng.restriction.period');
          const actor = this.actors.require();
          const created = await this.repo.insertRestriction({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            roomId: input.roomId,
            kind: input.kind,
            reason: input.reason,
            startsAt: input.startsAt ?? new Date(),
            endsAt: input.endsAt ?? null,
            workOrderId: input.workOrderId ?? null,
            createdByType: actor.type,
            createdById: isUuid(actor.id) ? actor.id : null,
          });
          if (!created) throw AppError.conflict('eng.restriction.already_restricted');
          await this.changed(scope, created, true);
          await this.audit.record({
            action: 'eng.restriction.create',
            entityType: 'room',
            entityId: created.roomId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            reason: created.reason,
            after: { kind: created.kind, restriction_id: created.id },
          });
          return created;
        }),
    );
    return this.tellPms(scope, row, true);
  }

  async release(scope: PropertyScope, id: string) {
    const row = await this.gate.execute(
      { action: 'eng.restriction.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const current = isUuid(id) ? await this.repo.restrictionForUpdate(scope, id) : undefined;
          if (!current) throw AppError.notFound('eng.restriction.not_found');
          if (current.releasedAt) throw AppError.conflict('eng.restriction.released');
          const actor = this.actors.require();
          const released = await this.repo.updateRestriction(scope, id, {
            releasedAt: new Date(),
            releasedByType: actor.type,
            releasedById: isUuid(actor.id) ? actor.id : null,
          });
          await this.changed(scope, released, false);
          await this.audit.record({
            action: 'eng.restriction.release',
            entityType: 'room',
            entityId: released.roomId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: { kind: current.kind },
            after: { released: true, restriction_id: released.id },
          });
          return released;
        }),
    );
    return this.tellPms(scope, row, false);
  }

  list(scope: PropertyScope, query: z.infer<typeof listRestrictionsSchema>) {
    return this.gate.execute(
      { action: 'eng.work_order.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.repo.restrictionsOf(scope, query.open)),
    );
  }

  private changed(scope: PropertyScope, r: RoomRestrictionRow, active: boolean) {
    return this.events.publish(RoomRestrictionChanged, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: 'eng',
      aggregate: { type: 'room', id: r.roomId },
      payload: { restriction_id: r.id, room_id: r.roomId, kind: r.kind, active },
    });
  }

  /**
   * Tells the PMS (`SET_ROOM_RESTRICTION`) through `PMS_API` when the property's capability registry has a connector
   * that may write restrictions (ADR-0019); records how it went.
   */
  private async tellPms(
    scope: PropertyScope,
    r: RoomRestrictionRow,
    active: boolean,
  ): Promise<RoomRestrictionRow> {
    let status: RoomRestrictionRow['pmsSync'] = 'NOT_REQUIRED';
    try {
      if (await this.pms.can(scope.tenantId, scope.propertyId, 'OOO_WRITE')) {
        const room = await this.org.getRoom(scope.tenantId, scope.propertyId, r.roomId);
        const outcome = await this.pms.setRoomRestriction({
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          roomNumber: room!.roomNumber,
          kind: r.kind,
          active,
          idempotencyKey: `eng-restriction-${r.id}-${active ? 'on' : 'off'}`,
          requestedBy: { type: 'SYSTEM', id: null },
          correlationId: this.ctx.correlationId,
        });
        status = outcome.outcome === 'QUEUED' ? 'SENT' : 'NOT_REQUIRED';
      }
    } catch (err) {
      this.logger.warn({ err, restriction_id: r.id }, 'room restriction not sent to the PMS');
      status = 'FAILED';
    }
    if (status === r.pmsSync) return r;
    return this.tx.run(() => this.repo.updateRestriction(scope, r.id, { pmsSync: status }));
  }
}
