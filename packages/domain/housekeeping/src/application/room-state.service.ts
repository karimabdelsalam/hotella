import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  type EventEnvelope,
  GuestCheckedIn,
  GuestCheckedOut,
  RoomSignalChanged,
  RoomStateChanged,
  RoomStatusChanged,
  StayRoomChanged,
} from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import {
  conflictingSignals,
  fromPmsStatus,
  HOUSEKEEPING,
  type HousekeepingState,
  isStale,
  type Occupancy,
  type RoomSignal,
  SIGNALS,
  type SignalSource,
  staffMoveAllowed,
  type StateCause,
} from '../domain/room-state';
import { HousekeepingRepositories } from '../infrastructure/repositories';
import type { RoomStateRow } from '../infrastructure/schema';
import { ReadinessService } from './readiness.service';

const HK = 'hk';

export const setStateSchema = z.object({
  housekeeping: z.enum(HOUSEKEEPING),
  version: z.number().int().min(1),
});
export const signalSchema = z.object({ signal: z.enum(SIGNALS), active: z.boolean() });

interface Actor {
  readonly type: string;
  readonly id: string | null;
}
const INTEGRATION: Actor = { type: 'INTEGRATION', id: null };

/**
 * The room operational projection (Spec §9): PMS events move occupancy and the front-office status, check-out makes a
 * room dirty, staff and jobs move housekeeping progress, and signals (DND, make up room…) live beside the state. Every
 * change is a history row and a `hk.room.state_changed.v1` event.
 */
@Injectable()
export class RoomStateService {
  /** Canonical PMS events this projection follows (worker consumer). */
  static readonly consumes = [GuestCheckedIn, GuestCheckedOut, StayRoomChanged, RoomStatusChanged];

  constructor(
    private readonly repo: HousekeepingRepositories,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly gate: ActionGate,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    private readonly readiness: ReadinessService,
  ) {}

  // ---- the PMS (CLAUDE.md rule 19: occupancy and front-office status are the PMS's) ----

  async applyPms(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId) return;
    const scope = { tenantId, propertyId };
    const at = new Date(envelope.occurred_at);
    await this.tx.run(async () => {
      switch (envelope.event_type) {
        case GuestCheckedIn.type: {
          const e = GuestCheckedIn.parse(envelope);
          await this.pms(scope, e.payload.room.room_id, at, { occupancy: 'OCCUPIED' });
          break;
        }
        case GuestCheckedOut.type: {
          const e = GuestCheckedOut.parse(envelope);
          if (e.payload.room)
            await this.pms(scope, e.payload.room.room_id, at, {
              occupancy: 'VACANT',
              housekeeping: 'DIRTY',
            });
          break;
        }
        case StayRoomChanged.type: {
          const e = StayRoomChanged.parse(envelope);
          if (e.payload.from_room)
            await this.pms(scope, e.payload.from_room.room_id, at, {
              occupancy: 'VACANT',
              housekeeping: 'DIRTY',
            });
          await this.pms(scope, e.payload.to_room.room_id, at, { occupancy: 'OCCUPIED' });
          break;
        }
        case RoomStatusChanged.type: {
          const e = RoomStatusChanged.parse(envelope);
          const mapped = fromPmsStatus(e.payload.status);
          await this.pms(scope, e.payload.room.room_id, at, {
            ...(mapped.housekeeping ? { housekeeping: mapped.housekeeping } : {}),
            // A housekeeping status from the PMS lifts a restriction it reported before.
            frontOffice: mapped.frontOffice,
            ...(e.payload.occupied === null
              ? {}
              : { occupancy: e.payload.occupied ? 'OCCUPIED' : 'VACANT' }),
          });
          break;
        }
      }
    });
  }

  private async pms(
    scope: PropertyScope,
    roomId: string,
    at: Date,
    to: { occupancy?: Occupancy; housekeeping?: HousekeepingState; frontOffice?: string | null },
  ) {
    const current = await this.repo.stateForUpdate(scope, roomId);
    if (isStale(at, current.lastPmsEventAt)) return;
    await this.move(scope, current, to, 'PMS', INTEGRATION, at, { lastPmsEventAt: at });
  }

  // ---- staff ----

  /** A person moves a room's housekeeping state by hand (`hk.room.manage`). */
  setByStaff(
    scope: PropertyScope,
    roomId: string,
    input: z.infer<typeof setStateSchema>,
    actor: Actor,
  ) {
    return this.gate.execute(
      { action: 'hk.room.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          await this.room(scope, roomId);
          const current = await this.repo.stateForUpdate(scope, roomId);
          if (current.version !== input.version)
            throw AppError.conflict('hk.room.version_conflict');
          if (!staffMoveAllowed(current.housekeeping, input.housekeeping))
            throw AppError.conflict('hk.room.move_not_allowed', {
              from: current.housekeeping,
              to: input.housekeeping,
            });
          const updated = await this.move(
            scope,
            current,
            { housekeeping: input.housekeeping },
            'STAFF',
            actor,
            new Date(),
          );
          await this.audit.record({
            action: 'hk.room.state',
            entityType: 'room',
            entityId: roomId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: { housekeeping: current.housekeeping },
            after: { housekeeping: updated.housekeeping },
          });
          return updated;
        }),
    );
  }

  /**
   * Moves the projection, writes the history and announces each changed dimension. Shared with jobs and inspections
   * (they pass their own cause and job id).
   */
  async move(
    scope: PropertyScope,
    current: RoomStateRow,
    to: { occupancy?: Occupancy; housekeeping?: HousekeepingState; frontOffice?: string | null },
    cause: StateCause,
    actor: Actor,
    at: Date,
    extra: { lastPmsEventAt?: Date; jobId?: string | null } = {},
  ): Promise<RoomStateRow> {
    const changes: Array<{
      dimension: 'OCCUPANCY' | 'HOUSEKEEPING' | 'FRONT_OFFICE';
      from: string | null;
      to: string | null;
    }> = [];
    if (to.occupancy && to.occupancy !== current.occupancy)
      changes.push({ dimension: 'OCCUPANCY', from: current.occupancy, to: to.occupancy });
    if (to.housekeeping && to.housekeeping !== current.housekeeping)
      changes.push({ dimension: 'HOUSEKEEPING', from: current.housekeeping, to: to.housekeeping });
    if (to.frontOffice !== undefined && to.frontOffice !== current.frontOffice)
      changes.push({ dimension: 'FRONT_OFFICE', from: current.frontOffice, to: to.frontOffice });
    if (changes.length === 0 && !extra.lastPmsEventAt) return current;
    const updated = await this.repo.updateState(scope, current.roomId, {
      ...(to.occupancy ? { occupancy: to.occupancy } : {}),
      ...(to.housekeeping ? { housekeeping: to.housekeeping } : {}),
      ...(to.frontOffice !== undefined ? { frontOffice: to.frontOffice } : {}),
      ...(to.housekeeping === 'CLEAN' && current.housekeeping !== 'CLEAN'
        ? { lastCleanedAt: at }
        : {}),
      ...(to.housekeeping === 'INSPECTED' ? { lastInspectedAt: at } : {}),
      ...(extra.lastPmsEventAt ? { lastPmsEventAt: extra.lastPmsEventAt } : {}),
    });
    for (const c of changes) {
      await this.repo.insertStateEvent({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        roomId: current.roomId,
        dimension: c.dimension,
        fromValue: c.from,
        toValue: c.to,
        cause,
        actorType: actor.type,
        actorId: actor.id && isUuid(actor.id) ? actor.id : null,
        jobId: extra.jobId ?? null,
        occurredAt: at,
      });
      await this.events.publish(RoomStateChanged, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: HK,
        aggregate: { type: 'room', id: current.roomId },
        payload: { room_id: current.roomId, dimension: c.dimension, from: c.from, to: c.to, cause },
      });
    }
    return changes.length > 0 ? this.readiness.refresh(scope, updated, at) : updated;
  }

  // ---- signals (Spec §9.3) ----

  /** Raises or clears a signal; raising one clears the signals it excludes (DND lifts make-up-room and back). */
  async signal(
    scope: PropertyScope,
    roomId: string,
    input: { signal: RoomSignal; active: boolean },
    source: SignalSource,
    actor: Actor,
  ): Promise<{ readonly active: readonly RoomSignal[] }> {
    return this.tx.run(async () => {
      await this.room(scope, roomId);
      const now = new Date();
      const set = async (signal: RoomSignal, active: boolean) => {
        const open = await this.repo.openSignal(scope, roomId, signal);
        if (active === Boolean(open)) return;
        if (open) await this.repo.endSignal(scope, open.id, toRef(actor), now);
        else
          await this.repo.insertSignal({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            roomId,
            signal,
            source,
            startedAt: now,
            startedByType: actor.type,
            startedById: toRef(actor).id,
          });
        await this.events.publish(RoomSignalChanged, {
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          source: HK,
          aggregate: { type: 'room', id: roomId },
          payload: { room_id: roomId, signal, active, source },
        });
      };
      if (input.active)
        for (const other of conflictingSignals(input.signal)) await set(other, false);
      await set(input.signal, input.active);
      return {
        active: (await this.repo.openSignals(scope))
          .filter((s) => s.roomId === roomId)
          .map((s) => s.signal),
      };
    });
  }

  /** The signals of a room that are on now. */
  activeSignals(scope: PropertyScope, roomId: string): Promise<RoomSignal[]> {
    return this.tx.read(async () =>
      (await this.repo.openSignals(scope)).filter((s) => s.roomId === roomId).map((s) => s.signal),
    );
  }

  /** Staff raise or clear a signal (`hk.room.manage`). */
  signalByStaff(
    scope: PropertyScope,
    roomId: string,
    input: z.infer<typeof signalSchema>,
    actor: Actor,
  ) {
    return this.gate.execute(
      { action: 'hk.room.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.signal(scope, roomId, input, 'STAFF', actor),
    );
  }

  // ---- the board ----

  /** Every room of the property with its state and open signals, by room number (`hk.board.read`). */
  board(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'hk.board.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const rooms = await this.org.listRooms(scope.tenantId, scope.propertyId);
          const states = new Map((await this.repo.statesOf(scope)).map((s) => [s.roomId, s]));
          const signals = await this.repo.openSignals(scope);
          return rooms
            .map((room) => {
              const s = states.get(room.id);
              return {
                roomId: room.id,
                roomNumber: room.roomNumber,
                roomTypeId: room.roomTypeId,
                floorLabel: room.floorLabel,
                occupancy: s?.occupancy ?? null,
                housekeeping: s?.housekeeping ?? null,
                frontOffice: s?.frontOffice ?? null,
                lastCleanedAt: s?.lastCleanedAt ?? null,
                lastInspectedAt: s?.lastInspectedAt ?? null,
                version: s?.version ?? null,
                ready: s?.ready ?? false,
                readySince: s?.readySince ?? null,
                signals: signals
                  .filter((x) => x.roomId === room.id)
                  .map((x) => ({ signal: x.signal, source: x.source, since: x.startedAt })),
              };
            })
            .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'en', { numeric: true }));
        }),
    );
  }

  history(scope: PropertyScope, roomId: string) {
    return this.gate.execute(
      { action: 'hk.board.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.room(scope, roomId);
          return this.repo.history(scope, roomId, 100);
        }),
    );
  }

  /** Why a room is or is not ready, dimension by dimension (`hk.board.read`). */
  roomReadiness(scope: PropertyScope, roomId: string) {
    return this.gate.execute(
      { action: 'hk.board.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.room(scope, roomId);
          const state = await this.repo.state(scope, roomId);
          if (!state)
            return { roomId, ready: false, occupied: false, tracked: false, dimensions: [] };
          return {
            roomId,
            tracked: true,
            readySince: state.readySince,
            ...(await this.readiness.evaluate(scope, state)),
          };
        }),
    );
  }

  /** The room must be one of the property's rooms (anything else is not found, rule 1). */
  private async room(scope: PropertyScope, roomId: string) {
    const room = isUuid(roomId)
      ? await this.org.getRoom(scope.tenantId, scope.propertyId, roomId)
      : null;
    if (!room) throw AppError.notFound('hk.room.not_found');
    return room;
  }
}

function toRef(actor: Actor): { type: string; id: string | null } {
  return { type: actor.type, id: actor.id && isUuid(actor.id) ? actor.id : null };
}
