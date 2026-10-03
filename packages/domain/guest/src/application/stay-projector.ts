import { Inject, Injectable } from '@nestjs/common';
import {
  type EventEnvelope,
  GuestCheckedIn,
  GuestCheckedOut,
  type GuestProfile,
  GuestProfileUpdated,
  GuestStayRoomChanged,
  type ReservationRef,
  ReservationCancelled,
  ReservationCreated,
  ReservationUpdated,
  StayCreated,
  StayRoomChanged,
  StayStatusChanged,
} from '@hotella/contracts-events';
import {
  EXTERNAL_ENTITY,
  INTEGRATIONS_API,
  type IntegrationsPublicApi,
} from '@hotella/domain-integrations/public';
import { AuditWriter } from '@hotella/platform-audit';
import { currentTransaction, newId, type TenantScope } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { normalizeEmail, normalizePhone, sameName } from '../domain/identity';
import { transition, type PmsFact } from '../domain/stay-state';
import { GuestRepositories } from '../infrastructure/repositories';
import type { GuestRow, RoomAssignmentRow, StayRow } from '../infrastructure/schema';

/** Internal entity types this context links to external ids (through the Integration Platform only). */
export const STAY_ENTITY = 'guest.stay';
export const GUEST_ENTITY = 'guest.guest';

type Envelope<P> = EventEnvelope<P>;
type AssignmentReason = RoomAssignmentRow['reason'];

interface Snapshot {
  readonly primary: GuestProfile;
  readonly accompanying: readonly GuestProfile[];
  readonly arrival: string;
  readonly departure: string;
  readonly adults: number;
  readonly children: number;
  readonly rateCode: string | null;
  readonly marketCode: string | null;
  readonly eta?: string | null;
}

/**
 * Applies canonical PMS facts to guests and stays (Spec §6, CLAUDE.md rule 19). This is the ONLY writer of stay
 * status: there is no staff or guest API that creates a guest or a stay or changes a stay's state. Runs inside the
 * idempotent consumer's transaction (inbox row + writes + outgoing events are atomic), serialized per reservation.
 */
/**
 * Facts of one stay travel on different queues and are processed concurrently, so a check-out or room move can reach
 * the projector before the check-in that creates the stay. Such a fact is retried (queue backoff) for a short window
 * instead of being dropped; after it, the reservation is genuinely unknown and reconciliation reports it (Spec §52).
 */
export const UNKNOWN_STAY_RETRY_WINDOW_MS = 20_000;
export class StayNotYetKnownError extends Error {
  constructor(eventType: string) {
    super(`${eventType}: stay not known yet; retrying`);
    this.name = 'StayNotYetKnownError';
  }
}

@Injectable()
export class StayProjector {
  constructor(
    private readonly repo: GuestRepositories,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Canonical events this projector consumes. */
  static readonly consumes = [
    ReservationCreated,
    ReservationUpdated,
    ReservationCancelled,
    GuestCheckedIn,
    GuestCheckedOut,
    StayRoomChanged,
    GuestProfileUpdated,
  ] as const;

  async apply(envelope: EventEnvelope): Promise<void> {
    if (!currentTransaction()) throw new Error('StayProjector.apply must run inside a transaction');
    if (!envelope.tenant_id || !envelope.property_id)
      throw new Error(`${envelope.event_type} without tenant/property scope`);
    switch (envelope.event_type) {
      case GuestCheckedIn.type:
        return this.checkedIn(GuestCheckedIn.parse(envelope));
      case GuestCheckedOut.type:
        return this.checkedOut(GuestCheckedOut.parse(envelope));
      case StayRoomChanged.type:
        return this.roomChanged(StayRoomChanged.parse(envelope));
      case ReservationCreated.type:
        return this.reservation(ReservationCreated.parse(envelope));
      case ReservationUpdated.type:
        return this.reservation(ReservationUpdated.parse(envelope));
      case ReservationCancelled.type:
        return this.cancelled(ReservationCancelled.parse(envelope));
      case GuestProfileUpdated.type:
        return this.profileUpdated(GuestProfileUpdated.parse(envelope));
      default:
        this.logger.debug({ event_type: envelope.event_type }, 'stay projector ignores event');
    }
  }

  // ---- event handlers ----

  private async checkedIn(e: Envelope<(typeof GuestCheckedIn)['payload']['_output']>) {
    const p = e.payload;
    const at = new Date(p.checked_in_at);
    const ctx = await this.begin(e, p.reservation, [p.primary_guest, ...p.accompanying_guests]);
    const snapshot = this.snapshotOf(p, p.primary_guest, p.accompanying_guests);
    let stay = await this.findStay(ctx, p.reservation);
    if (!stay) {
      stay = await this.createStay(ctx, p.reservation, snapshot, 'IN_HOUSE', at, { checkinAt: at });
      await this.moveRoom(ctx, stay, p.room.room_id, 'INITIAL', at, e.event_id);
      await this.statusChanged(ctx, stay, 'EXPECTED', at, p.room.room_id);
      return this.touchReference(ctx, stay, p.reservation, e);
    }
    const t = transition(stay, { kind: 'CHECKED_IN', at });
    const values: Partial<StayRow> = {};
    if (t.applySnapshot) Object.assign(values, await this.applySnapshot(ctx, stay, snapshot, at));
    if (t.status !== stay.status) {
      values.status = t.status;
      values.actualCheckinAt = at;
      if (t.reinstated) values.actualCheckoutAt = null;
    } else if (stay.status === 'IN_HOUSE' && !stay.actualCheckinAt) values.actualCheckinAt = at;
    const before = stay;
    stay = await this.save(ctx, stay, values, at);
    if (stay.status === 'IN_HOUSE' && (t.applySnapshot || t.status !== before.status))
      await this.moveRoom(
        ctx,
        stay,
        p.room.room_id,
        t.status !== before.status ? 'INITIAL' : 'ROOM_MOVE',
        at,
        e.event_id,
      );
    if (t.status !== before.status)
      await this.statusChanged(ctx, stay, before.status, at, p.room.room_id);
    await this.touchReference(ctx, stay, p.reservation, e);
  }

  private async checkedOut(e: Envelope<(typeof GuestCheckedOut)['payload']['_output']>) {
    const p = e.payload;
    const at = new Date(p.checked_out_at);
    const ctx = await this.begin(e, p.reservation, []);
    let stay = await this.findStay(ctx, p.reservation);
    if (!stay) {
      // Nothing to close or revoke; reconciliation reports the reservation if it matters (Spec §52).
      return this.unknownStay(e, 'check-out for an unknown reservation ignored');
    }
    const t = transition(stay, { kind: 'CHECKED_OUT', at });
    if (t.status === stay.status) {
      await this.save(ctx, stay, {}, at);
      return this.touchReference(ctx, stay, p.reservation, e);
    }
    const before = stay;
    const open = await this.repo.openAssignment(ctx.scope, stay.id);
    if (open) await this.repo.closeAssignment(ctx.scope, open.id, maxDate(at, open.assignedAt));
    stay = await this.save(ctx, stay, { status: t.status, actualCheckoutAt: at }, at);
    await this.statusChanged(ctx, stay, before.status, at, open?.roomId ?? p.room?.room_id ?? null);
    await this.touchReference(ctx, stay, p.reservation, e);
  }

  private async roomChanged(e: Envelope<(typeof StayRoomChanged)['payload']['_output']>) {
    const p = e.payload;
    const at = new Date(p.changed_at);
    const ctx = await this.begin(e, p.reservation, []);
    const stay = await this.findStay(ctx, p.reservation);
    if (!stay) return this.unknownStay(e, 'room change for an unknown stay ignored');
    if (stay.status !== 'IN_HOUSE' && stay.status !== 'EXPECTED') {
      this.logger.warn(
        { event_id: e.event_id, status: stay.status },
        'room change for a closed stay ignored',
      );
      return;
    }
    const open = await this.repo.openAssignment(ctx.scope, stay.id);
    if (open && at < open.assignedAt) {
      this.logger.info(
        { event_id: e.event_id },
        'stale room change ignored (newer assignment exists)',
      );
      return;
    }
    await this.moveRoom(ctx, stay, p.to_room.room_id, p.reason, at, e.event_id);
    await this.save(ctx, stay, {}, at);
    await this.touchReference(ctx, stay, p.reservation, e);
  }

  private async reservation(
    e: Envelope<(typeof ReservationCreated)['payload']['_output']>,
  ): Promise<void> {
    const p = e.payload;
    const at = new Date(e.occurred_at);
    const ctx = await this.begin(e, p.reservation, [p.primary_guest, ...p.accompanying_guests]);
    const snapshot = this.snapshotOf(p, p.primary_guest, p.accompanying_guests);
    let stay = await this.findStay(ctx, p.reservation);
    if (!stay) {
      stay = await this.createStay(ctx, p.reservation, snapshot, 'EXPECTED', at, {});
      if (p.room) await this.moveRoom(ctx, stay, p.room.room_id, 'PRE_ASSIGNMENT', at, e.event_id);
      return this.touchReference(ctx, stay, p.reservation, e);
    }
    const t = transition(stay, { kind: 'RESERVATION', at });
    const values: Partial<StayRow> = {};
    if (t.applySnapshot) Object.assign(values, await this.applySnapshot(ctx, stay, snapshot, at));
    if (t.status !== stay.status) Object.assign(values, { status: t.status, cancelledAt: null });
    const before = stay;
    stay = await this.save(ctx, stay, values, at);
    if (t.applySnapshot && stay.status === 'EXPECTED' && p.room)
      await this.moveRoom(ctx, stay, p.room.room_id, 'PRE_ASSIGNMENT', at, e.event_id);
    if (t.status !== before.status) await this.statusChanged(ctx, stay, before.status, at, null);
    await this.touchReference(ctx, stay, p.reservation, e);
  }

  private async cancelled(e: Envelope<(typeof ReservationCancelled)['payload']['_output']>) {
    const p = e.payload;
    const at = new Date(p.cancelled_at);
    const ctx = await this.begin(e, p.reservation, []);
    let stay = await this.findStay(ctx, p.reservation);
    if (!stay) return this.unknownStay(e, 'cancellation of an unknown reservation ignored');
    const fact: PmsFact = { kind: 'CANCELLED', at, outcome: p.outcome };
    const t = transition(stay, fact);
    if (t.status === stay.status) {
      this.logger.info({ event_id: e.event_id, status: stay.status }, 'cancellation ignored');
      return;
    }
    const before = stay;
    const open = await this.repo.openAssignment(ctx.scope, stay.id);
    if (open) await this.repo.closeAssignment(ctx.scope, open.id, maxDate(at, open.assignedAt));
    stay = await this.save(ctx, stay, { status: t.status, cancelledAt: at }, at);
    await this.statusChanged(ctx, stay, before.status, at, null);
    await this.touchReference(ctx, stay, p.reservation, e);
  }

  private async profileUpdated(e: Envelope<(typeof GuestProfileUpdated)['payload']['_output']>) {
    const p = e.payload;
    const ctx = await this.begin(e, p.reservation, [p.profile]);
    let target: GuestRow | null = null;
    if (p.profile.external_id) target = await this.guestByProfile(ctx, p.profile.external_id);
    if (!target && p.reservation) {
      const stay = await this.findStay(ctx, p.reservation);
      if (stay) target = (await this.repo.guest(ctx.scope, stay.primaryGuestId)) ?? null;
    }
    if (!target) {
      this.logger.info({ event_id: e.event_id }, 'profile update for an unknown guest ignored');
      return;
    }
    await this.updateGuestFromProfile(ctx, target, p.profile);
  }

  // ---- building blocks ----

  /** A fresh fact about a stay that does not exist yet is retried; an old one is reported and ignored. */
  private unknownStay(e: EventEnvelope, message: string): void {
    const received = Date.parse(e.received_at || e.occurred_at);
    if (Date.now() - received < UNKNOWN_STAY_RETRY_WINDOW_MS)
      throw new StayNotYetKnownError(e.event_type);
    this.logger.warn({ event_id: e.event_id }, message);
  }

  private async begin(
    e: EventEnvelope,
    reservation: ReservationRef | null,
    profiles: readonly GuestProfile[],
  ): Promise<Ctx> {
    const tenantId = e.tenant_id!;
    const instanceId = reservation?.integration_instance_id ?? null;
    // Lock order: reservation first, then profiles sorted — concurrent consumers never deadlock on each other.
    if (reservation)
      await this.repo.lockKey(`res:${tenantId}:${instanceId}:${reservation.external_id}`);
    const profileIds = [
      ...new Set(profiles.map((x) => x.external_id).filter((x): x is string => Boolean(x))),
    ].sort();
    for (const id of profileIds) await this.repo.lockKey(`prof:${tenantId}:${instanceId}:${id}`);
    return {
      scope: { tenantId },
      tenantId,
      propertyId: e.property_id!,
      instanceId,
      actor: { type: 'INTEGRATION' as const, id: instanceId },
    };
  }

  private async findStay(ctx: Ctx, ref: ReservationRef): Promise<StayRow | null> {
    const id = await this.integrations.resolveReference(
      ctx.tenantId,
      ref.integration_instance_id,
      EXTERNAL_ENTITY.RESERVATION,
      ref.external_id,
    );
    if (!id) return null;
    const stay = await this.repo.stayForUpdate(ctx.scope, id);
    // Integrity faults are loud (the job fails and lands in the dead-letter set), never silently re-created.
    if (!stay) throw new Error('reservation reference points to a missing stay');
    if (stay.propertyId !== ctx.propertyId)
      throw new Error('reservation reference points to a stay of another property');
    return stay;
  }

  private snapshotOf(
    p: {
      arrival_date: string;
      departure_date: string;
      adults: number;
      children: number;
      rate_code: string | null;
      market_code: string | null;
      eta?: string | null;
    },
    primary: GuestProfile,
    accompanying: readonly GuestProfile[],
  ): Snapshot {
    return {
      primary,
      accompanying,
      arrival: p.arrival_date,
      departure: p.departure_date,
      adults: p.adults,
      children: p.children,
      rateCode: p.rate_code,
      marketCode: p.market_code,
      eta: p.eta,
    };
  }

  private async createStay(
    ctx: Ctx,
    ref: ReservationRef,
    s: Snapshot,
    status: 'EXPECTED' | 'IN_HOUSE',
    at: Date,
    extra: { checkinAt?: Date },
  ): Promise<StayRow> {
    const primary = await this.resolveGuest(ctx, s.primary, []);
    const stay = await this.repo.insertStay({
      id: newId(),
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      status,
      primaryGuestId: primary.id,
      expectedArrival: s.arrival,
      expectedDeparture: s.departure,
      actualCheckinAt: extra.checkinAt ?? null,
      eta: s.eta ? new Date(s.eta) : null,
      adults: s.adults,
      children: s.children,
      rateCode: s.rateCode,
      marketCode: s.marketCode,
      lastPmsEventAt: at,
    });
    const winner = await this.integrations.linkReference({
      tenantId: ctx.tenantId,
      integrationInstanceId: ref.integration_instance_id,
      internalEntityType: STAY_ENTITY,
      internalEntityId: stay.id,
      externalEntityType: EXTERNAL_ENTITY.RESERVATION,
      externalId: ref.external_id,
    });
    // Serialized by the reservation lock; a different winner means the lock was bypassed — fail and retry.
    if (winner !== stay.id) throw new Error('reservation already linked to another stay');
    await this.syncParty(ctx, stay, primary, s.accompanying, at);
    await this.events.publish(StayCreated, {
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      source: 'guest',
      aggregate: { type: 'stay', id: stay.id },
      payload: { stay_id: stay.id, primary_guest_id: primary.id, status },
    });
    await this.audit.record({
      action: 'guest.stay.create',
      entityType: 'stay',
      entityId: stay.id,
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      actor: ctx.actor,
      after: stay,
    });
    return stay;
  }

  /** Snapshot fields of a newer PMS fact; returns the stay columns to update. */
  private async applySnapshot(
    ctx: Ctx,
    stay: StayRow,
    s: Snapshot,
    at: Date,
  ): Promise<Partial<StayRow>> {
    const party = await this.repo.activeParty(ctx.scope, stay.id);
    const partyGuests = await this.repo.guestsByIds(
      ctx.scope,
      party.map((m) => m.guestId),
    );
    const primary = await this.resolveGuest(ctx, s.primary, partyGuests);
    await this.syncParty(ctx, stay, primary, s.accompanying, at, partyGuests);
    return {
      primaryGuestId: primary.id,
      expectedArrival: s.arrival,
      expectedDeparture: s.departure,
      adults: s.adults,
      children: s.children,
      rateCode: s.rateCode,
      marketCode: s.marketCode,
      ...(s.eta !== undefined ? { eta: s.eta ? new Date(s.eta) : null } : {}),
    };
  }

  /** Brings the active party in line with the snapshot; departed members keep their history row. */
  private async syncParty(
    ctx: Ctx,
    stay: StayRow,
    primary: GuestRow,
    accompanying: readonly GuestProfile[],
    at: Date,
    knownGuests: readonly GuestRow[] = [],
  ): Promise<void> {
    const desired = new Map<string, 'PRIMARY' | 'ACCOMPANYING'>([[primary.id, 'PRIMARY']]);
    for (const profile of accompanying) {
      const g = await this.resolveGuest(ctx, profile, knownGuests);
      if (!desired.has(g.id)) desired.set(g.id, 'ACCOMPANYING');
    }
    const active = await this.repo.activeParty(ctx.scope, stay.id);
    for (const m of active) {
      if (desired.get(m.guestId) !== m.role) await this.repo.closePartyMember(ctx.scope, m.id, at);
    }
    const kept = new Set(
      active.filter((m) => desired.get(m.guestId) === m.role).map((m) => m.guestId),
    );
    for (const [guestId, role] of desired) {
      if (kept.has(guestId)) continue;
      await this.repo.addPartyMember({
        id: newId(),
        tenantId: ctx.tenantId,
        stayId: stay.id,
        guestId,
        role,
        joinedAt: at,
      });
    }
  }

  /**
   * Finds or creates the guest for a PMS profile. Deterministic and conservative: by the profile's external
   * reference, else by name among the stay's current party (a repeated snapshot), else a new guest. Guests are never
   * matched across stays by name or contact data — duplicates are merged by staff (Spec §6).
   */
  private async resolveGuest(
    ctx: Ctx,
    profile: GuestProfile,
    candidates: readonly GuestRow[],
  ): Promise<GuestRow> {
    let guest: GuestRow | null = null;
    if (profile.external_id) guest = await this.guestByProfile(ctx, profile.external_id);
    if (!guest)
      guest =
        candidates.find(
          (c) =>
            c.status === 'ACTIVE' &&
            sameName(c, { givenName: profile.given_name, familyName: profile.family_name }),
        ) ?? null;
    if (guest) {
      await this.updateGuestFromProfile(ctx, guest, profile);
      return guest;
    }
    const created = await this.repo.insertGuest({
      id: newId(),
      tenantId: ctx.tenantId,
      givenName: profile.given_name,
      familyName: profile.family_name,
      title: profile.title,
      primaryLocale: profile.locale,
      vipCode: profile.vip_code,
    });
    if (profile.external_id && ctx.instanceId) {
      const winner = await this.integrations.linkReference({
        tenantId: ctx.tenantId,
        integrationInstanceId: ctx.instanceId,
        internalEntityType: GUEST_ENTITY,
        internalEntityId: created.id,
        externalEntityType: EXTERNAL_ENTITY.PROFILE,
        externalId: profile.external_id,
      });
      if (winner !== created.id) throw new Error('profile already linked to another guest');
    }
    await this.addIdentifiers(ctx, created.id, profile);
    return created;
  }

  private async guestByProfile(ctx: Ctx, externalId: string): Promise<GuestRow | null> {
    if (!ctx.instanceId) return null;
    let id = await this.integrations.resolveReference(
      ctx.tenantId,
      ctx.instanceId,
      EXTERNAL_ENTITY.PROFILE,
      externalId,
    );
    // Follow merges to the surviving guest.
    for (let hops = 0; id && hops < 10; hops++) {
      const g = await this.repo.guest(ctx.scope, id);
      if (!g) return null;
      if (g.status !== 'MERGED' || !g.mergedIntoGuestId) return g;
      id = g.mergedIntoGuestId;
    }
    return null;
  }

  private async updateGuestFromProfile(ctx: Ctx, guest: GuestRow, p: GuestProfile) {
    if (guest.status === 'ANONYMIZED') return;
    const next = {
      givenName: p.given_name,
      familyName: p.family_name ?? guest.familyName,
      title: p.title ?? guest.title,
      primaryLocale: p.locale ?? guest.primaryLocale,
      vipCode: p.vip_code ?? guest.vipCode,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (k) => next[k] !== guest[k],
    );
    if (changed.length > 0) {
      await this.repo.updateGuest(ctx.scope, guest.id, next);
      await this.audit.record({
        action: 'guest.guest.update_from_pms',
        entityType: 'guest',
        entityId: guest.id,
        tenantId: ctx.tenantId,
        propertyId: ctx.propertyId,
        actor: ctx.actor,
        // Field names only: guest personal data never enters the append-only audit log (Spec §69 anonymization).
        after: { changed },
      });
    }
    await this.addIdentifiers(ctx, guest.id, p);
  }

  private async addIdentifiers(ctx: Ctx, guestId: string, p: GuestProfile) {
    const values: Array<{ kind: 'EMAIL' | 'PHONE' | 'LOYALTY'; value: string | null }> = [
      { kind: 'EMAIL', value: p.email ? normalizeEmail(p.email) : null },
      { kind: 'PHONE', value: p.phone ? normalizePhone(p.phone) : null },
      { kind: 'LOYALTY', value: p.loyalty_number?.trim() || null },
    ];
    for (const v of values) {
      if (!v.value) continue;
      await this.repo.addIdentifier({
        id: newId(),
        tenantId: ctx.tenantId,
        guestId,
        kind: v.kind,
        valueNormalized: v.value,
        source: 'PMS',
      });
    }
  }

  /** Closes the open assignment and opens one for `roomId` (history is never overwritten). */
  private async moveRoom(
    ctx: Ctx,
    stay: StayRow,
    roomId: string,
    reason: AssignmentReason,
    at: Date,
    eventId: string,
  ): Promise<void> {
    const open = await this.repo.openAssignment(ctx.scope, stay.id);
    if (open?.roomId === roomId) return;
    // An older fact (e.g. a check-in processed after a later room move) never moves the guest back. A pre-assignment
    // is a plan, stamped when the reservation arrived, and always gives way.
    if (open && open.reason !== 'PRE_ASSIGNMENT' && at < open.assignedAt) {
      this.logger.info(
        { event_id: eventId },
        'stale room assignment ignored (newer assignment exists)',
      );
      return;
    }
    const effective = open ? maxDate(at, open.assignedAt) : at;
    if (open) await this.repo.closeAssignment(ctx.scope, open.id, effective);
    await this.repo.insertAssignment({
      id: newId(),
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      stayId: stay.id,
      roomId,
      assignedAt: effective,
      reason,
      sourceEventId: eventId,
    });
    await this.events.publish(GuestStayRoomChanged, {
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      source: 'guest',
      aggregate: { type: 'stay', id: stay.id },
      payload: {
        stay_id: stay.id,
        from_room_id: open?.roomId ?? null,
        to_room_id: roomId,
        reason,
        at: effective.toISOString(),
      },
    });
  }

  private async save(
    ctx: Ctx,
    stay: StayRow,
    values: Partial<StayRow>,
    at: Date,
  ): Promise<StayRow> {
    return this.repo.updateStay(ctx.scope, stay.id, {
      ...values,
      lastPmsEventAt: maxDate(stay.lastPmsEventAt, at),
    });
  }

  private async statusChanged(
    ctx: Ctx,
    stay: StayRow,
    from: StayRow['status'],
    at: Date,
    roomId: string | null,
  ): Promise<void> {
    await this.events.publish(StayStatusChanged, {
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      source: 'guest',
      aggregate: { type: 'stay', id: stay.id },
      occurredAt: at,
      payload: {
        stay_id: stay.id,
        primary_guest_id: stay.primaryGuestId,
        from,
        to: stay.status,
        at: at.toISOString(),
        room_id: roomId,
      },
    });
    await this.audit.record({
      action: 'guest.stay.status_change',
      entityType: 'stay',
      entityId: stay.id,
      tenantId: ctx.tenantId,
      propertyId: ctx.propertyId,
      actor: ctx.actor,
      before: { status: from },
      after: { status: stay.status, at: at.toISOString(), room_id: roomId },
    });
  }

  private async touchReference(ctx: Ctx, stay: StayRow, ref: ReservationRef, e: EventEnvelope) {
    await this.repo.upsertReservationReference({
      id: newId(),
      tenantId: ctx.tenantId,
      stayId: stay.id,
      integrationInstanceId: ref.integration_instance_id,
      confirmationNumber: ref.confirmation_number,
      lastEventType: `${e.event_type}.v${e.event_version}`,
      lastEventAt: new Date(e.occurred_at),
    });
  }
}

interface Ctx {
  readonly scope: TenantScope;
  readonly tenantId: string;
  readonly propertyId: string;
  readonly instanceId: string | null;
  readonly actor: { readonly type: 'INTEGRATION'; readonly id: string | null };
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}
