import { createHash, randomBytes, randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  GUEST_API,
  type GrantActor,
  type GuestPublicApi,
  type StayPartyMember,
} from '@hotella/domain-guest/public';
import {
  ORGANIZATION_API,
  type OrganizationPublicApi,
  type PropertySummary,
} from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { SettingsReader } from '@hotella/platform-settings';
import {
  attemptGate,
  autoFallback,
  deriveOtp,
  manualFallback,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  otpMatches,
  type OtpChannel,
  PHONE_SESSIONS_PER_HOUR,
  sameFamilyName,
} from '../domain/otp';
import { toE164 } from '../domain/phone';
import { COMMS_ACTIVATION_TOKEN_TTL_HOURS } from '../domain/settings';
import { ActivationRepositories } from '../infrastructure/activation-repositories';
import type {
  ActivationTokenRow,
  RoomQrCodeRow,
  VerificationSessionRow,
} from '../infrastructure/schema';
import { ChannelIdentityService } from './identity.service';
import { OtpKeyring, OtpSender } from './otp-delivery';

export const startActivationSchema = z.object({ token: z.string().min(16).max(128) });
export const requestOtpSchema = z
  .object({
    token: z.string().min(16).max(128).optional(),
    qrToken: z.string().min(16).max(128).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(6).max(32),
  })
  .refine((v) => Boolean(v.token) !== Boolean(v.qrToken), {
    message: 'exactly one of token or qrToken',
    path: ['token'],
  })
  .refine((v) => !v.qrToken || Boolean(v.lastName), { message: 'required', path: ['lastName'] });
export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export const handleSchema = z.object({ handle: z.string().min(16).max(128) });
export const verifyOtpSchema = z.object({
  handle: z.string().min(16).max(128),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
  device: z.string().trim().max(200).optional(),
});
export const completeSchema = z.object({
  handle: z.string().min(16).max(128),
  device: z.string().trim().max(200).optional(),
});
export const qrVerifySchema = z.object({ lastName: z.string().trim().min(1).max(100) });

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}
/** Short reference the guest reads to front desk (no ambiguous characters). */
function newReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export interface IssuedToken {
  readonly id: string;
  readonly token: string;
  readonly url: string;
  readonly expiresAt: string;
}

export interface CompletedActivation {
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

/** Where a verification starts: an activation link or a room QR code plus a last name. */
interface VerificationContext {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly stayId: string;
  readonly roomId: string | null;
  readonly party: readonly StayPartyMember[];
  readonly token: ActivationTokenRow | null;
  readonly qr: RoomQrCodeRow | null;
  /** The party member already identified (token for a guest, QR last-name match). */
  readonly guestId: string | null;
}

/**
 * Guest activation (Spec §19–§20, ADR-0011, ADR-0015): activation links and room QR codes lead to one OTP
 * verification of a phone number; a verified session becomes a grant and a guest session exactly once. No step needs
 * the PMS beyond the stay it already reported (CLAUDE.md rule 19).
 */
@Injectable()
export class ActivationService {
  constructor(
    private readonly repo: ActivationRepositories,
    private readonly sender: OtpSender,
    private readonly keyring: OtpKeyring,
    private readonly identities: ChannelIdentityService,
    private readonly settings: SettingsReader,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---- activation links ----

  /** Mints a link for a stay (revoking the previous open one for the same guest); the token is returned once. */
  async issueToken(input: {
    tenantId: string;
    propertyId: string;
    stayId: string;
    guestId: string | null;
    deliveredVia: 'STAFF' | 'WHATSAPP';
    actor: GrantActor;
  }): Promise<IssuedToken> {
    const stay = await this.guests.getStay(input.tenantId, input.stayId);
    if (!stay || stay.propertyId !== input.propertyId)
      throw AppError.notFound('guest.stay.not_found');
    if (stay.status !== 'EXPECTED' && stay.status !== 'IN_HOUSE')
      throw AppError.conflict('comms.activation.stay_not_active');
    if (input.guestId && !stay.partyGuestIds.includes(input.guestId))
      throw AppError.conflict('guest.grant.not_in_party');
    const hours = await this.settings.value(COMMS_ACTIVATION_TOKEN_TTL_HOURS, input);
    const now = new Date();
    const token = newSecret();
    const row = await this.tx.run(async () => {
      await this.repo.revokeOpenTokens({ tenantId: input.tenantId }, stay.id, input.guestId, now);
      const created = await this.repo.insertToken({
        id: newId(),
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        stayId: stay.id,
        guestId: input.guestId,
        tokenHash: hashSecret(token),
        deliveredVia: input.deliveredVia,
        expiresAt: new Date(now.getTime() + hours * 3_600_000),
        createdByType: input.actor.type,
        createdById: input.actor.id,
      });
      await this.audit.record({
        action: 'comms.activation_token.issue',
        entityType: 'activation_token',
        entityId: created.id,
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        actor: input.actor,
        after: { stay_id: stay.id, guest_id: input.guestId, delivered_via: input.deliveredVia },
      });
      return created;
    });
    return {
      id: row.id,
      token,
      url: this.url('a', token),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  url(kind: 'a' | 'q', token: string): string {
    return `${this.config.app.publicBaseUrl.replace(/\/+$/, '')}/${kind}/${token}`;
  }

  /** The landing step of a link: only the property it belongs to (no guest data before verification). */
  async start(
    token: string,
  ): Promise<{ propertyId: string; propertyName: string; expiresAt: string }> {
    const row = await this.liveToken(token);
    const property = await this.org.getProperty(row.tenantId, row.propertyId);
    return {
      propertyId: row.propertyId,
      propertyName: property?.name ?? '',
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  // ---- room QR codes (Spec §20) ----

  /** The room a printed code names; nothing about who stays there. */
  async resolveQr(
    qrToken: string,
  ): Promise<{ propertyId: string; propertyName: string; roomNumber: string }> {
    const qr = await this.liveQr(qrToken);
    const [property, room] = await Promise.all([
      this.org.getProperty(qr.tenantId, qr.propertyId),
      this.org.getRoom(qr.tenantId, qr.propertyId, qr.roomId),
    ]);
    return {
      propertyId: qr.propertyId,
      propertyName: property?.name ?? '',
      roomNumber: room?.roomNumber ?? '',
    };
  }

  /** Room + last name against the stays in house in that room right now; the same generic answer for any mismatch. */
  async checkQr(qrToken: string, lastName: string): Promise<{ ok: true }> {
    await this.qrContext(qrToken, lastName);
    return { ok: true };
  }

  // ---- OTP ----

  async requestOtp(
    input: RequestOtpInput,
    locale: string,
  ): Promise<{
    handle: string;
    expiresAt: string;
    sentVia: OtpChannel | null;
    reference: string;
    resendAfter: string;
  }> {
    const ctx = input.token
      ? await this.tokenContext(input.token)
      : await this.qrContext(input.qrToken!, input.lastName!);
    const property = await this.property(ctx.tenantId, ctx.propertyId);
    const phone = toE164(input.phone, property.country);
    if (!phone) throw new AppError('comms.otp.invalid_phone', HttpStatus.UNPROCESSABLE_ENTITY);
    const guestId = ctx.guestId ?? this.matchGuest(ctx.party, phone, property.country);
    if (!guestId) throw AppError.conflict('comms.activation.stay_not_active');
    const handle = newSecret();
    const now = new Date();
    const scope = { tenantId: ctx.tenantId, propertyId: ctx.propertyId };
    const result = await this.tx.run(async () => {
      const recent = await this.repo.phoneSessionsSince(
        scope,
        phone,
        new Date(now.getTime() - 3_600_000),
      );
      if (recent >= PHONE_SESSIONS_PER_HOUR)
        throw new AppError('comms.otp.too_many_requests', HttpStatus.TOO_MANY_REQUESTS);
      const session = await this.repo.insertSession({
        id: newId(),
        tenantId: ctx.tenantId,
        propertyId: ctx.propertyId,
        stayId: ctx.stayId,
        roomId: ctx.roomId,
        guestId,
        activationTokenId: ctx.token?.id ?? null,
        roomQrCodeId: ctx.qr?.id ?? null,
        phoneNormalized: phone,
        otpSeed: randomBytes(16).toString('hex'),
        handleHash: hashSecret(handle),
        locale,
        reference: newReference(),
        maxAttempts: OTP_MAX_ATTEMPTS,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      });
      await this.identities.observe(ctx.tenantId, 'WHATSAPP', phone, now);
      const policy = await this.sender.policy(ctx.tenantId, ctx.propertyId);
      const { chain, channels } = await this.sender.chain(scope, policy);
      const sentVia = chain.length
        ? await this.sender.send(
            session,
            chain[0]!,
            chain.slice(1),
            channels,
            'INITIAL',
            property.name,
          )
        : null;
      return { session, sentVia, policy };
    });
    return {
      handle,
      expiresAt: result.session.expiresAt.toISOString(),
      sentVia: result.sentVia,
      reference: result.session.reference,
      resendAfter: new Date(
        now.getTime() + result.policy.manualFallbackAfterSeconds * 1000,
      ).toISOString(),
    };
  }

  /** "Didn't get the code?": the same code on the next channel, once the manual fallback delay passed. */
  async resend(handle: string): Promise<{ sentVia: OtpChannel; resendAfter: string }> {
    const outcome = await this.tx.run(async () => {
      const session = await this.openSession(handle);
      const scope = { tenantId: session.tenantId, propertyId: session.propertyId };
      const policy = await this.sender.policy(session.tenantId, session.propertyId);
      const { chain, channels } = await this.sender.chain(scope, policy);
      const deliveries = await this.repo.deliveriesOf(scope, session.id);
      const decision = manualFallback(chain, deliveries, policy, new Date());
      if (decision.kind !== 'SEND') return decision;
      const property = await this.property(session.tenantId, session.propertyId);
      const tried = new Set(deliveries.map((d) => d.channel));
      const sentVia = await this.sender.send(
        session,
        decision.channel,
        chain.filter((c) => !tried.has(c)),
        channels,
        'MANUAL_FALLBACK',
        property.name,
      );
      return sentVia
        ? { kind: 'SENT' as const, sentVia, after: policy.manualFallbackAfterSeconds }
        : { kind: 'EXHAUSTED' as const };
    });
    if (outcome.kind === 'WAIT')
      throw new AppError('comms.otp.resend_too_early', HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSeconds: Math.max(1, Math.ceil((outcome.until.getTime() - Date.now()) / 1000)),
      });
    if (outcome.kind === 'EXHAUSTED') throw AppError.conflict('comms.otp.no_more_channels');
    return {
      sentVia: outcome.sentVia,
      resendAfter: new Date(Date.now() + outcome.after * 1000).toISOString(),
    };
  }

  /** Checks a code: every attempt counts (committed even when wrong); the limit locks the session. */
  async verify(handle: string, code: string, device: string | null): Promise<CompletedActivation> {
    const key = await this.keyring.key();
    const outcome = await this.tx.run(async () => {
      const session = await this.repo.sessionByHandleForUpdate(hashSecret(handle));
      if (!session) return { kind: 'UNKNOWN' as const };
      const now = new Date();
      const gate = attemptGate(session, now);
      if (gate !== 'OPEN') return { kind: gate };
      const scope = { tenantId: session.tenantId };
      const attempts = session.attempts + 1;
      const expected = deriveOtp(key, session.id, session.otpSeed);
      if (!otpMatches(expected, code)) {
        const locked = attempts >= session.maxAttempts;
        await this.repo.updateSession(scope, session.id, {
          attempts,
          ...(locked ? { lockedAt: now } : {}),
        });
        return locked
          ? { kind: 'LOCKED' as const }
          : { kind: 'INVALID' as const, remaining: session.maxAttempts - attempts };
      }
      const deliveries = await this.repo.deliveriesOf(scope, session.id);
      const via = [...deliveries].reverse().find((d) => d.status !== 'FAILED')?.channel ?? 'SMS';
      const verified = await this.repo.updateSession(scope, session.id, {
        attempts,
        verifiedAt: now,
        verifiedVia: via,
      });
      return { kind: 'VERIFIED' as const, session: verified };
    });
    switch (outcome.kind) {
      case 'VERIFIED':
        return this.complete(handle, device);
      case 'INVALID':
        throw new AppError('comms.otp.invalid', HttpStatus.BAD_REQUEST, {
          remaining: outcome.remaining,
        });
      case 'LOCKED':
        throw new AppError('comms.otp.locked', HttpStatus.TOO_MANY_REQUESTS);
      case 'EXPIRED':
        throw new AppError('comms.otp.expired', HttpStatus.GONE);
      case 'ALREADY_VERIFIED':
        return this.complete(handle, device);
      default:
        throw AppError.notFound('comms.otp.session_not_found');
    }
  }

  /**
   * Turns a verified session (OTP or staff-assisted) into a grant and a guest session — exactly once. The activation
   * link is consumed here (single use; a replay is 410).
   */
  async complete(handle: string, device: string | null): Promise<CompletedActivation> {
    return this.tx.run(async () => {
      const session = await this.repo.sessionByHandleForUpdate(hashSecret(handle));
      if (!session) throw AppError.notFound('comms.otp.session_not_found');
      if (!session.verifiedAt) throw AppError.conflict('comms.otp.not_verified');
      if (session.completedAt) throw new AppError('comms.otp.already_completed', HttpStatus.GONE);
      const now = new Date();
      const scope: TenantScope = { tenantId: session.tenantId };
      if (
        session.activationTokenId &&
        !(await this.repo.consumeToken(scope, session.activationTokenId, now))
      )
        throw new AppError('comms.activation.token_invalid', HttpStatus.GONE);
      const actor: GrantActor = session.assistedByUserId
        ? { type: 'USER', id: session.assistedByUserId }
        : { type: 'GUEST', id: session.guestId };
      for (const type of ['WHATSAPP', 'SMS'] as const)
        await this.identities.verify(
          session.tenantId,
          type,
          session.phoneNormalized,
          session.guestId,
          now,
        );
      const grant = await this.guests.issueGrant({
        tenantId: session.tenantId,
        propertyId: session.propertyId,
        stayId: session.stayId,
        guestId: session.guestId,
        via: session.assistedByUserId ? 'STAFF' : session.roomQrCodeId ? 'QR' : 'ACTIVATION',
        actor,
      });
      const opened = await this.guests.openGuestSession(session.tenantId, grant.id, device);
      await this.repo.updateSession(scope, session.id, { completedAt: now });
      await this.audit.record({
        action: 'comms.verification.complete',
        entityType: 'verification_session',
        entityId: session.id,
        tenantId: session.tenantId,
        propertyId: session.propertyId,
        actor,
        after: { grant_id: grant.id, verified_via: session.verifiedVia },
      });
      return {
        sessionToken: opened.token,
        expiresAt: opened.expiresAt,
        scopes: grant.effectiveScopes,
      };
    });
  }

  // ---- automatic fallback (worker sweep, ADR-0015) ----

  async sweepFallbacks(now: Date = new Date(), limit = 200): Promise<number> {
    let sent = 0;
    for (const { id, tenantId } of await this.repo.openSessionIds(now, limit)) {
      const done = await this.tx
        .run(async () => {
          const session = await this.repo.claimOpenSession({ tenantId }, id);
          if (!session || session.verifiedAt || session.lockedAt || session.expiresAt <= now)
            return false;
          const scope = { tenantId, propertyId: session.propertyId };
          const policy = await this.sender.policy(tenantId, session.propertyId);
          const deliveries = await this.repo.deliveriesOf(scope, session.id);
          const { chain, channels } = await this.sender.chain(scope, policy);
          const next = autoFallback(chain, deliveries, policy, now);
          if (!next) return false;
          const tried = new Set(deliveries.map((d) => d.channel));
          const property = await this.property(tenantId, session.propertyId);
          return (
            (await this.sender.send(
              session,
              next,
              chain.filter((c) => !tried.has(c)),
              channels,
              'AUTO_FALLBACK',
              property.name,
            )) !== null
          );
        })
        .catch((e: unknown) => {
          // One session's failure never stops the sweep; no personal data in the log.
          this.logger.warn({ session_id: id, err: e }, 'OTP fallback sweep skipped a session');
          return false;
        });
      if (done) sent++;
    }
    return sent;
  }

  /** A provider receipt for an OTP message (webhooks, 4.3): DELIVERED/READ stop the automatic fallback. */
  async deliveryStatus(
    tenantId: string,
    channelId: string,
    providerRef: string,
    status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
    at: Date,
    errorCode: string | null = null,
  ): Promise<boolean> {
    return this.tx.run(async () =>
      Boolean(
        await this.repo.updateDeliveryStatus(
          { tenantId },
          channelId,
          providerRef,
          status,
          at,
          errorCode,
        ),
      ),
    );
  }

  // ---- helpers ----

  private async liveToken(token: string): Promise<ActivationTokenRow> {
    const row = await this.repo.tokenByHash(hashSecret(token));
    if (!row || row.usedAt || row.revokedAt || row.expiresAt <= new Date())
      throw new AppError('comms.activation.token_invalid', HttpStatus.GONE);
    return row;
  }

  private async liveQr(qrToken: string): Promise<RoomQrCodeRow> {
    const qr = await this.repo.qrByHash(hashSecret(qrToken));
    if (!qr || qr.status !== 'ACTIVE') throw AppError.notFound('comms.qr.not_found');
    return qr;
  }

  private async tokenContext(token: string): Promise<VerificationContext> {
    const row = await this.liveToken(token);
    const stay = await this.guests.getStay(row.tenantId, row.stayId);
    if (!stay || (stay.status !== 'EXPECTED' && stay.status !== 'IN_HOUSE'))
      throw AppError.conflict('comms.activation.stay_not_active');
    return {
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      stayId: row.stayId,
      roomId: stay.currentRoomId,
      party: await this.guests.stayParty(row.tenantId, row.stayId),
      token: row,
      qr: null,
      guestId: row.guestId,
    };
  }

  private async qrContext(qrToken: string, lastName: string): Promise<VerificationContext> {
    const qr = await this.liveQr(qrToken);
    for (const stay of await this.guests.inHouseStaysInRoom(
      qr.tenantId,
      qr.propertyId,
      qr.roomId,
    )) {
      const party = await this.guests.stayParty(qr.tenantId, stay.id);
      const member = party.find((m) => sameFamilyName(m.familyName, lastName));
      if (member)
        return {
          tenantId: qr.tenantId,
          propertyId: qr.propertyId,
          stayId: stay.id,
          roomId: qr.roomId,
          party,
          token: null,
          qr,
          guestId: member.guestId,
        };
    }
    // One generic answer: no hint whether the room is occupied or the name was close.
    throw new AppError('comms.qr.no_match', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /** The party member whose PMS phone matches, else the primary guest (who holds the link handed over at check-in). */
  private matchGuest(
    party: readonly StayPartyMember[],
    phone: string,
    country: string | null,
  ): string | null {
    const byPhone = party.find((m) => m.phones.some((p) => toE164(p, country) === phone));
    return byPhone?.guestId ?? party.find((m) => m.role === 'PRIMARY')?.guestId ?? null;
  }

  private async openSession(handle: string): Promise<VerificationSessionRow> {
    const session = await this.repo.sessionByHandleForUpdate(hashSecret(handle));
    if (!session) throw AppError.notFound('comms.otp.session_not_found');
    const gate = attemptGate(session, new Date());
    if (gate === 'EXPIRED') throw new AppError('comms.otp.expired', HttpStatus.GONE);
    if (gate === 'LOCKED') throw new AppError('comms.otp.locked', HttpStatus.TOO_MANY_REQUESTS);
    if (gate === 'ALREADY_VERIFIED') throw AppError.conflict('comms.otp.already_verified');
    return session;
  }

  private async property(tenantId: string, propertyId: string): Promise<PropertySummary> {
    const p = await this.org.getProperty(tenantId, propertyId);
    if (!p) throw AppError.notFound('org.property.not_found');
    return p;
  }
}
