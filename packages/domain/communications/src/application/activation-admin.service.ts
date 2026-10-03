import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { GUEST_API, type GrantActor, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError, I18nService } from '@hotella/platform-i18n';
import { AttributionPolicyService, SettingsReader } from '@hotella/platform-settings';
import { attemptGate } from '../domain/otp';
import { maskPhone } from '../domain/phone';
import { COMMS_OTP_STAFF_ASSIST_ENABLED } from '../domain/settings';
import { ActivationRepositories } from '../infrastructure/activation-repositories';
import { ActivationService, hashSecret, newSecret } from './activation.service';
import { renderQrSheet } from './qr-sheet';

export const issueTokenSchema = z.object({ guestId: z.uuid().optional() });
export const qrSheetSchema = z.object({ roomIds: z.array(z.uuid()).min(1).max(2000).optional() });
export const assistSchema = z.object({ reason: z.string().trim().min(5).max(500) });
export const referenceQuerySchema = z.object({
  reference: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/),
});

/** Front desk: activation links for a stay and staff-assisted verification (ADR-0015 option 4). */
@Injectable()
export class ActivationAdminService {
  constructor(
    private readonly activation: ActivationService,
    private readonly repo: ActivationRepositories,
    private readonly settings: SettingsReader,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
  ) {}

  issue(
    scope: PropertyScope,
    stayId: string,
    input: { guestId?: string | undefined },
    actor: GrantActor,
  ) {
    return this.gate.execute(
      { action: 'guest.activation.issue', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => {
        if (!isUuid(stayId)) throw AppError.notFound('guest.stay.not_found');
        return this.activation.issueToken({
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          stayId,
          guestId: input.guestId ?? null,
          deliveredVia: 'STAFF',
          actor,
        });
      },
    );
  }

  list(scope: PropertyScope, stayId: string) {
    return this.gate.execute(
      { action: 'guest.activation.issue', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          if (!isUuid(stayId)) throw AppError.notFound('guest.stay.not_found');
          const now = new Date();
          return (await this.repo.tokensOfStay(scope, stayId)).map((t) => ({
            id: t.id,
            guestId: t.guestId,
            deliveredVia: t.deliveredVia,
            createdAt: t.createdAt,
            expiresAt: t.expiresAt,
            usedAt: t.usedAt,
            revokedAt: t.revokedAt,
            state: t.usedAt
              ? 'USED'
              : t.revokedAt
                ? 'REVOKED'
                : t.expiresAt <= now
                  ? 'EXPIRED'
                  : 'OPEN',
          }));
        }),
    );
  }

  revoke(scope: PropertyScope, tokenId: string) {
    return this.gate.execute(
      { action: 'guest.activation.issue', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          if (!isUuid(tokenId) || !(await this.repo.revokeToken(scope, tokenId, new Date())))
            throw AppError.notFound('comms.activation.token_not_found');
          await this.audit.record({
            action: 'comms.activation_token.revoke',
            entityType: 'activation_token',
            entityId: tokenId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
          });
          return { revoked: true };
        }),
    );
  }

  /** Open verification sessions matching the reference the guest reads out (masked phone, name, room). */
  findForAssist(scope: PropertyScope, reference: string) {
    return this.gate.execute(
      { action: 'guest.activation.assist', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const out = [];
          for (const s of await this.repo.openSessionsByReference(scope, reference, new Date())) {
            const member = (await this.guests.stayParty(scope.tenantId, s.stayId)).find(
              (m) => m.guestId === s.guestId,
            );
            out.push({
              id: s.id,
              reference: s.reference,
              stayId: s.stayId,
              guest: member ? { givenName: member.givenName, familyName: member.familyName } : null,
              phone: maskPhone(s.phoneNormalized),
              createdAt: s.createdAt,
              expiresAt: s.expiresAt,
            });
          }
          return out;
        }),
    );
  }

  /** Staff confirmed the guest's identity in person: the session counts as verified (audited with the reason). */
  assist(scope: PropertyScope, sessionId: string, reason: string, actor: GrantActor) {
    return this.gate.execute(
      { action: 'guest.activation.assist', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        if (!(await this.settings.value(COMMS_OTP_STAFF_ASSIST_ENABLED, scope)))
          throw AppError.conflict('comms.otp.assist_disabled');
        return this.tx.run(async () => {
          const session = isUuid(sessionId)
            ? await this.repo.sessionForUpdate(scope, sessionId)
            : undefined;
          if (!session || session.propertyId !== scope.propertyId)
            throw AppError.notFound('comms.otp.session_not_found');
          const now = new Date();
          const gate = attemptGate(session, now);
          if (gate === 'ALREADY_VERIFIED') throw AppError.conflict('comms.otp.already_verified');
          // A session locked by wrong codes may still be confirmed in person; an expired one may not.
          if (session.expiresAt <= now) throw new AppError('comms.otp.expired', HttpStatus.GONE);
          await this.repo.updateSession(scope, session.id, {
            verifiedAt: now,
            verifiedVia: 'STAFF',
            assistedByUserId: actor.id && isUuid(actor.id) ? actor.id : null,
          });
          await this.repo.insertDelivery({
            id: newId(),
            tenantId: scope.tenantId,
            sessionId: session.id,
            channel: 'STAFF',
            trigger: 'STAFF_ASSIST',
            status: 'DELIVERED',
            sentAt: now,
            statusAt: now,
          });
          await this.audit.record({
            action: 'comms.verification.assist',
            entityType: 'verification_session',
            entityId: session.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            actor,
            reason,
            after: { stay_id: session.stayId, guest_id: session.guestId },
          });
          return { verified: true };
        });
      },
    );
  }
}

/** Room QR codes (Spec §20): generated, rotated and revoked by the platform; printed codes carry an opaque token. */
@Injectable()
export class RoomQrAdminService {
  constructor(
    private readonly activation: ActivationService,
    private readonly repo: ActivationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly attribution: AttributionPolicyService,
    private readonly i18n: I18nService,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  list(scope: PropertyScope) {
    return this.act(scope, 'read', async () => {
      const rooms = new Map(
        (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [
          r.id,
          r.roomNumber,
        ]),
      );
      return (await this.repo.listQr(scope)).map((q) => ({
        id: q.id,
        roomId: q.roomId,
        roomNumber: rooms.get(q.roomId) ?? null,
        status: q.status,
        createdAt: q.createdAt,
        statusChangedAt: q.statusChangedAt,
      }));
    });
  }

  /** Generates the room's code, rotating the current one; the token (and its URL) is returned once. */
  generate(scope: PropertyScope, roomId: string) {
    return this.act(scope, 'write', async () => {
      const room = isUuid(roomId)
        ? await this.org.getRoom(scope.tenantId, scope.propertyId, roomId)
        : null;
      if (!room) throw AppError.notFound('org.room.not_found');
      return this.rotate(scope, room.id, room.roomNumber);
    });
  }

  private async rotate(scope: PropertyScope, roomId: string, roomNumber: string) {
    const now = new Date();
    const current = await this.repo.activeQrForRoom(scope, roomId);
    if (current) await this.repo.setQrStatus(scope, current.id, 'ROTATED', now);
    const token = newSecret();
    const row = await this.repo.insertQr({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      roomId,
      tokenHash: hashSecret(token),
      rotatedFromId: current?.id ?? null,
      statusChangedAt: now,
    });
    await this.audit.record({
      action: current ? 'comms.room_qr.rotate' : 'comms.room_qr.generate',
      entityType: 'room_qr_code',
      entityId: row.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      after: { room_id: roomId, rotated_from: current?.id ?? null },
    });
    return { id: row.id, roomId, roomNumber, token, url: this.activation.url('q', token) };
  }

  /**
   * A printable sheet for the given rooms (default: every room of the property). Printing needs the tokens, which are
   * only shown once, so the sheet *rotates* the codes it prints: codes printed earlier stop working (Spec §20).
   */
  sheet(scope: PropertyScope, roomIds: readonly string[] | undefined, locale: string) {
    return this.act(scope, 'write', async () => {
      const rooms = (await this.org.listRooms(scope.tenantId, scope.propertyId))
        .filter((r) => !roomIds || roomIds.includes(r.id))
        .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'en', { numeric: true }));
      if (roomIds && rooms.length !== new Set(roomIds).size)
        throw AppError.notFound('org.room.not_found');
      const cards = [];
      for (const room of rooms) {
        const generated = await this.rotate(scope, room.id, room.roomNumber);
        cards.push({ roomNumber: room.roomNumber, url: generated.url });
      }
      const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
      const attribution = await this.attribution.resolve(scope.tenantId);
      await this.audit.record({
        action: 'comms.room_qr.sheet',
        entityType: 'property',
        entityId: scope.propertyId,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { rooms: rooms.length },
      });
      return renderQrSheet(
        cards,
        {
          title: this.i18n.t('comms.qr.sheet_title', { property: property?.name ?? '' }, locale),
          room: this.i18n.t('comms.qr.room', {}, locale),
          instruction: this.i18n.t('comms.qr.instruction', {}, locale),
          attribution: attribution.show
            ? { label: attribution.label, href: attribution.href }
            : null,
        },
        locale,
        this.i18n.direction(locale),
      );
    });
  }

  revoke(scope: PropertyScope, roomId: string) {
    return this.act(scope, 'write', async () => {
      const current = isUuid(roomId) ? await this.repo.activeQrForRoom(scope, roomId) : undefined;
      if (!current) throw AppError.notFound('comms.qr.not_found');
      await this.repo.setQrStatus(scope, current.id, 'REVOKED', new Date());
      await this.audit.record({
        action: 'comms.room_qr.revoke',
        entityType: 'room_qr_code',
        entityId: current.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { room_id: roomId },
      });
      return { revoked: true };
    });
  }

  private act<T>(scope: PropertyScope, mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'qr.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (mode === 'read' ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}
