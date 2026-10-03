import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GuestGrantChanged, GuestGrantIssued, GuestGrantRevoked } from '@hotella/contracts-events';
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
import { SettingsReader } from '@hotella/platform-settings';
import {
  decideGrant,
  effectiveScopes,
  type GrantPolicy,
  grantOnStayStatus,
  type GuestScope,
  type PartyRole,
  sessionExpiry,
} from '../domain/access';
import {
  GUEST_GRANT_COMPANION_SCOPES,
  GUEST_GRANT_IN_STAY_SCOPES,
  GUEST_GRANT_POST_STAY_HOURS,
  GUEST_GRANT_POST_STAY_SCOPES,
  GUEST_GRANT_PRE_ARRIVAL_SCOPES,
} from '../domain/settings';
import { AccessRepositories } from '../infrastructure/access-repositories';
import { GuestRepositories } from '../infrastructure/repositories';
import type { GuestAccessGrantRow, StayRow } from '../infrastructure/schema';
import type {
  GrantActor,
  GrantSummary,
  GuestPrincipal,
  IssueGrantInput,
  OpenedGuestSession,
} from '../public';

export const revokeGrantSchema = z.object({ reason: z.string().trim().min(5).max(500) });
export type RevokeGrantInput = z.infer<typeof revokeGrantSchema>;

/** Last-seen updates are throttled: a busy guest page must not write on every request. */
const TOUCH_EVERY_MS = 60_000;

export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Guest access grants and sessions (Spec §19.3, §21, ADR-0011). Grants are issued only for a verified guest of an
 * active stay (communications calls `issueGrant` after OTP, QR or staff-assisted verification); they follow the stay
 * as the PMS moves it, inside the projector's transaction, so a checked-out guest never keeps in-stay access.
 */
@Injectable()
export class GuestAccessService {
  constructor(
    private readonly repo: AccessRepositories,
    private readonly guests: GuestRepositories,
    private readonly settings: SettingsReader,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly tx: TransactionRunner,
  ) {}

  async policy(tenantId: string, propertyId: string): Promise<GrantPolicy> {
    const at = { tenantId, propertyId };
    const [inStay, companion, preArrival, postStay, postStayHours] = await Promise.all([
      this.settings.value(GUEST_GRANT_IN_STAY_SCOPES, at),
      this.settings.value(GUEST_GRANT_COMPANION_SCOPES, at),
      this.settings.value(GUEST_GRANT_PRE_ARRIVAL_SCOPES, at),
      this.settings.value(GUEST_GRANT_POST_STAY_SCOPES, at),
      this.settings.value(GUEST_GRANT_POST_STAY_HOURS, at),
    ]);
    return {
      inStayScopes: inStay,
      companionScopes: companion,
      preArrivalScopes: preArrival,
      postStayScopes: postStay,
      postStayHours,
    };
  }

  // ---- issuing (called by communications through GUEST_API, after verification) ----

  issueGrant(input: IssueGrantInput): Promise<GrantSummary> {
    return this.tx.run(async () => {
      const scope = { tenantId: input.tenantId };
      const stay = await this.guests.stayForUpdate(scope, input.stayId);
      if (!stay || stay.propertyId !== input.propertyId)
        throw AppError.notFound('guest.stay.not_found');
      const now = input.now ?? new Date();
      const existing = await this.repo.liveGrant(scope, stay.id, input.guestId, now);
      if (existing) return summary(existing, now);
      const member = (await this.guests.activeParty(scope, stay.id)).find(
        (m) => m.guestId === input.guestId,
      );
      const decision = decideGrant({
        status: stay.status,
        partyRole: member?.role ?? null,
        expectedDeparture: stay.expectedDeparture,
        policy: await this.policy(input.tenantId, stay.propertyId),
      });
      if (decision.kind === 'REFUSE')
        throw AppError.conflict(
          decision.reason === 'STAY_NOT_ACTIVE'
            ? 'guest.grant.stay_not_active'
            : 'guest.grant.not_in_party',
        );
      const via = stay.status === 'EXPECTED' ? 'PRE_ARRIVAL' : input.via;
      const grant = await this.repo.insertGrant({
        id: newId(),
        tenantId: input.tenantId,
        propertyId: stay.propertyId,
        guestId: input.guestId,
        stayId: stay.id,
        partyRole: member!.role,
        scopes: [...decision.scopes],
        validFrom: now,
        validUntil: decision.validUntil,
        grantedVia: via,
        grantedByType: input.actor.type,
        grantedById: input.actor.id,
      });
      await this.repo.insertGrantEvent({
        id: newId(),
        tenantId: input.tenantId,
        grantId: grant.id,
        kind: 'GRANTED',
        scopes: grant.scopes,
        validUntil: grant.validUntil,
        reason: via,
        changedByType: input.actor.type,
        changedById: input.actor.id,
        at: now,
      });
      await this.events.publish(GuestGrantIssued, {
        tenantId: input.tenantId,
        propertyId: stay.propertyId,
        source: 'guest',
        aggregate: { type: 'guest_access_grant', id: grant.id },
        occurredAt: now,
        payload: {
          grant_id: grant.id,
          guest_id: grant.guestId,
          stay_id: grant.stayId,
          scopes: grant.scopes,
          granted_via: via,
          valid_until: grant.validUntil.toISOString(),
        },
      });
      await this.audit.record({
        action: 'guest.grant.issue',
        entityType: 'guest_access_grant',
        entityId: grant.id,
        tenantId: input.tenantId,
        propertyId: stay.propertyId,
        actor: input.actor,
        ...(input.reason ? { reason: input.reason } : {}),
        after: { stay_id: stay.id, guest_id: grant.guestId, scopes: grant.scopes, via },
      });
      return summary(grant, now);
    });
  }

  /** Opens a session on a live grant; the opaque token is returned once (only its SHA-256 is stored). */
  openSession(
    tenantId: string,
    grantId: string,
    deviceInfo: string | null,
    now: Date = new Date(),
  ): Promise<OpenedGuestSession> {
    return this.tx.run(async () => {
      const grant = await this.repo.grant({ tenantId }, grantId);
      if (!grant || effectiveScopes(grant, now).length === 0)
        throw AppError.conflict('guest.grant.not_active');
      const token = randomBytes(32).toString('base64url');
      const session = await this.repo.insertSession({
        id: newId(),
        tenantId,
        grantId,
        sessionTokenHash: hashGuestToken(token),
        deviceInfo: deviceInfo ? deviceInfo.slice(0, 200) : null,
        lastSeenAt: now,
        expiresAt: sessionExpiry(now, grant.validUntil),
      });
      return { token, sessionId: session.id, expiresAt: session.expiresAt.toISOString() };
    });
  }

  /**
   * Resolves a guest session token on every request (ADR-0011): the session must be live and its grant must still
   * carry scopes right now. Returns null for anything else, so callers answer one generic 401.
   */
  async authenticate(token: string, now: Date = new Date()): Promise<GuestPrincipal | null> {
    if (!token || token.length > 128) return null;
    const found = await this.repo.sessionByTokenHash(hashGuestToken(token));
    if (!found) return null;
    const { session, grant } = found;
    if (session.revokedAt || session.expiresAt <= now) return null;
    const scopes = effectiveScopes(grant, now);
    if (scopes.length === 0) return null;
    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_EVERY_MS)
      await this.tx.run(() =>
        this.repo.touchSession(
          { tenantId: session.tenantId },
          session.id,
          now,
          sessionExpiry(now, grant.validUntil),
        ),
      );
    return {
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      guestId: grant.guestId,
      stayId: grant.stayId,
      grantId: grant.id,
      sessionId: session.id,
      scopes,
    };
  }

  revokeSession(tenantId: string, sessionId: string, reason: string): Promise<boolean> {
    return this.tx.run(() =>
      isUuid(sessionId)
        ? this.repo.revokeSession({ tenantId }, sessionId, reason.slice(0, 32), new Date())
        : Promise.resolve(false),
    );
  }

  /** The guest's live grant at a property, for routing a verified channel identity to its stay. */
  async liveGrantAtProperty(
    tenantId: string,
    propertyId: string,
    guestId: string,
    now: Date = new Date(),
  ): Promise<GrantSummary | null> {
    const grant = await this.repo.latestLiveGrantAtProperty({ tenantId, propertyId }, guestId, now);
    return grant && effectiveScopes(grant, now).length > 0 ? summary(grant, now) : null;
  }

  // ---- following the stay (inside the projector's transaction) ----

  async followStay(
    stay: StayRow,
    to: StayRow['status'],
    at: Date,
    actor: GrantActor,
  ): Promise<void> {
    const scope = { tenantId: stay.tenantId };
    const grants = await this.repo.liveGrantsOfStay(scope, stay.id);
    if (grants.length === 0) return;
    const policy = await this.policy(stay.tenantId, stay.propertyId);
    for (const grant of grants) {
      const change = grantOnStayStatus(grant, to, at, policy);
      if (!change) continue;
      if (change.kind === 'REVOKED') await this.revoke(grant, change.reason, at, actor);
      else await this.change(grant, change, at, actor);
    }
  }

  /** Anonymization and merges end every grant of the guest (inside the caller's transaction). */
  async revokeAllOfGuest(scope: TenantScope, guestId: string, reason: string, actor: GrantActor) {
    const now = new Date();
    for (const grant of await this.repo.liveGrantsOfGuest(scope, guestId)) {
      await this.revoke(grant, reason, now, actor);
      if (reason === 'ANONYMIZED') await this.repo.clearDeviceInfoOfGrant(scope, grant.id);
    }
  }

  private async change(
    grant: GuestAccessGrantRow,
    change: {
      kind: 'WIDENED' | 'NARROWED';
      scopes: readonly GuestScope[];
      validUntil: Date;
      reason: string;
    },
    at: Date,
    actor: GrantActor,
  ): Promise<void> {
    const scope = { tenantId: grant.tenantId };
    const updated = await this.repo.updateGrant(scope, grant.id, {
      scopes: [...change.scopes],
      validUntil: change.validUntil,
    });
    if (change.validUntil < grant.validUntil)
      await this.repo.capSessionsOfGrant(scope, grant.id, change.validUntil);
    await this.repo.insertGrantEvent({
      id: newId(),
      tenantId: grant.tenantId,
      grantId: grant.id,
      kind: change.kind,
      scopes: updated.scopes,
      validUntil: updated.validUntil,
      reason: change.reason,
      changedByType: actor.type,
      changedById: actor.id,
      at,
    });
    await this.events.publish(GuestGrantChanged, {
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      source: 'guest',
      aggregate: { type: 'guest_access_grant', id: grant.id },
      occurredAt: at,
      payload: {
        grant_id: grant.id,
        guest_id: grant.guestId,
        stay_id: grant.stayId,
        change: change.kind,
        scopes: updated.scopes,
        valid_until: updated.validUntil.toISOString(),
        reason: change.reason,
      },
    });
    await this.audit.record({
      action: change.kind === 'WIDENED' ? 'guest.grant.widen' : 'guest.grant.narrow',
      entityType: 'guest_access_grant',
      entityId: grant.id,
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      actor,
      before: { scopes: grant.scopes, valid_until: grant.validUntil.toISOString() },
      after: { scopes: updated.scopes, valid_until: updated.validUntil.toISOString() },
    });
  }

  /** Ends a grant and its sessions (inside the caller's transaction). */
  async revoke(
    grant: GuestAccessGrantRow,
    reason: string,
    at: Date,
    actor: GrantActor,
    note?: string,
  ): Promise<GuestAccessGrantRow> {
    const scope = { tenantId: grant.tenantId };
    const revoked = await this.repo.updateGrant(scope, grant.id, {
      revokedAt: at,
      revokeReason: reason,
    });
    const sessions = await this.repo.revokeSessionsOfGrant(scope, grant.id, reason, at);
    await this.repo.insertGrantEvent({
      id: newId(),
      tenantId: grant.tenantId,
      grantId: grant.id,
      kind: 'REVOKED',
      scopes: grant.scopes,
      validUntil: grant.validUntil,
      reason,
      changedByType: actor.type,
      changedById: actor.id,
      at,
    });
    await this.events.publish(GuestGrantRevoked, {
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      source: 'guest',
      aggregate: { type: 'guest_access_grant', id: grant.id },
      occurredAt: at,
      payload: {
        grant_id: grant.id,
        guest_id: grant.guestId,
        stay_id: grant.stayId,
        reason,
        sessions_revoked: sessions,
      },
    });
    await this.audit.record({
      action: 'guest.grant.revoke',
      entityType: 'guest_access_grant',
      entityId: grant.id,
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      actor,
      ...(note ? { reason: note } : {}),
      before: { scopes: grant.scopes },
      after: { revoked: reason, sessions_revoked: sessions },
    });
    return revoked;
  }
}

/** Staff view and revocation of grants (API process; permission-gated). */
@Injectable()
export class GuestAccessAdminService {
  constructor(
    private readonly access: GuestAccessService,
    private readonly repo: AccessRepositories,
    private readonly guests: GuestRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
  ) {}

  listForStay(scope: PropertyScope, stayId: string) {
    return this.gate.execute(
      { action: 'stay.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const stay = isUuid(stayId) ? await this.guests.stay(scope, stayId) : undefined;
          if (!stay || stay.propertyId !== scope.propertyId)
            throw AppError.notFound('guest.stay.not_found');
          const now = new Date();
          const out = [];
          for (const g of await this.repo.grantsOfStay(scope, stay.id))
            out.push({ ...summary(g, now), history: await this.repo.grantEvents(scope, g.id) });
          return out;
        }),
    );
  }

  revokeByStaff(scope: PropertyScope, grantId: string, input: RevokeGrantInput, actor: GrantActor) {
    return this.gate.execute(
      { action: 'guest.grant.revoke', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const grant = isUuid(grantId)
            ? await this.repo.grantForUpdate(scope, grantId)
            : undefined;
          if (!grant || grant.propertyId !== scope.propertyId)
            throw AppError.notFound('guest.grant.not_found');
          if (grant.revokedAt) throw AppError.conflict('guest.grant.already_revoked');
          const now = new Date();
          const revoked = await this.access.revoke(grant, 'STAFF', now, actor, input.reason);
          return summary(revoked, now);
        }),
    );
  }
}

function summary(g: GuestAccessGrantRow, now: Date): GrantSummary {
  return {
    id: g.id,
    propertyId: g.propertyId,
    guestId: g.guestId,
    stayId: g.stayId,
    partyRole: g.partyRole as PartyRole,
    scopes: [...g.scopes],
    effectiveScopes: [...effectiveScopes(g, now)],
    grantedVia: g.grantedVia,
    validFrom: g.validFrom.toISOString(),
    validUntil: g.validUntil.toISOString(),
    revokedAt: g.revokedAt?.toISOString() ?? null,
    revokeReason: g.revokeReason,
  };
}
