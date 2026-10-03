import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { SessionRevoked } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import type { RequestActor } from '@hotella/platform-auth';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { TransactionRunner } from '@hotella/platform-database';
import { AuditWriter } from '@hotella/platform-audit';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { ConfigurationService } from '@hotella/platform-settings';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from '../domain/passwords';
import { staffActorType } from '../domain/access';
import { IAM_PASSWORD_MIN_LENGTH } from '../domain/settings';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../domain/totp';
import { seal, sha256Hex, unseal } from '../domain/tokens';
import { IdentityKeys } from '../infrastructure/keys';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { UserRow } from '../infrastructure/schema';
import type { AcceptInvitationInput, LoginInput, MfaVerifyInput } from './dto';
import { type IssuedTokens, TokenService } from './token.service';

export interface ClientMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export type LoginResult =
  | ({ readonly mfaRequired: false } & IssuedTokens)
  | { readonly mfaRequired: true; readonly challengeToken: string };

type RevokeReason = 'LOGOUT' | 'TOKEN_REUSE' | 'USER_DISABLED' | 'PASSWORD_CHANGED' | 'ADMIN';

const invalidCredentials = (): AppError =>
  new AppError('iam.auth.invalid_credentials', HttpStatus.UNAUTHORIZED);

/** Staff authentication flows (ADR-0011). Every failure is the same generic 401 so accounts cannot be enumerated. */
@Injectable()
export class AuthService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly tokens: TokenService,
    private readonly keys: IdentityKeys,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly settings: ConfigurationService,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: LoginInput, meta: ClientMeta): Promise<LoginResult> {
    let tenantId: string | null = null;
    if (input.tenantCode) {
      const tenant = await this.org.findTenantByCode(input.tenantCode);
      if (!tenant || tenant.status !== 'ACTIVE') {
        await burnPasswordCheck(input.password);
        throw invalidCredentials();
      }
      tenantId = tenant.id;
    }
    const user = await this.repo.userByLogin(tenantId, input.email);
    if (!user || !user.passwordHash) {
      await burnPasswordCheck(input.password);
      throw invalidCredentials();
    }
    const now = new Date();
    if (user.status !== 'ACTIVE' || (user.lockedUntil && user.lockedUntil > now)) {
      await burnPasswordCheck(input.password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      await this.recordFailure(user, now);
      throw invalidCredentials();
    }
    if (user.mfaEnabled) {
      return { mfaRequired: true, challengeToken: await this.tokens.signMfaChallenge(user.id) };
    }
    return { mfaRequired: false, ...(await this.openSession(user, meta, false, now)) };
  }

  async verifyMfa(input: MfaVerifyInput, meta: ClientMeta): Promise<IssuedTokens> {
    const userId = await this.tokens.verifyMfaChallenge(input.challengeToken);
    if (!userId) throw invalidCredentials();
    const user = await this.repo.userById(userId);
    const now = new Date();
    if (!user || user.status !== 'ACTIVE' || !user.mfaEnabled || !user.mfaSecretEnc)
      throw invalidCredentials();
    if (user.lockedUntil && user.lockedUntil > now) throw invalidCredentials();
    const secret = unseal(user.mfaSecretEnc, this.keys.mfaSealingKey);
    const step = verifyTotp(secret, input.code, now.getTime(), user.mfaLastStep);
    if (step === null || !(await this.repo.claimMfaStep(user.id, step))) {
      await this.recordFailure(user, now);
      throw new AppError('iam.auth.invalid_mfa_code', HttpStatus.UNAUTHORIZED);
    }
    return this.openSession(user, meta, true, now);
  }

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const now = new Date();
    const result = await this.tx.run(async () => {
      const r = await this.tokens.rotate(refreshToken, now);
      if (r.kind === 'reuse') await this.revoke(r.sessionId, r.userId, 'TOKEN_REUSE', now);
      return r;
    });
    if (result.kind !== 'ok')
      throw new AppError('iam.auth.invalid_refresh_token', HttpStatus.UNAUTHORIZED);
    const live = await this.repo.liveSession(result.session.id, now);
    if (!live) throw new AppError('iam.auth.invalid_refresh_token', HttpStatus.UNAUTHORIZED);
    const access = await this.tokens.signAccess({
      userId: live.user.id,
      tenantId: live.user.tenantId,
      sessionId: live.session.id,
      isPlatformAdmin: live.user.isPlatformAdmin,
      locale: live.person.localePref,
    });
    return {
      accessToken: access.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.refreshExpiresAt.toISOString(),
      sessionId: live.session.id,
    };
  }

  async logout(actor: RequestActor): Promise<void> {
    if (!actor.sessionId) return;
    await this.tx.run(() => this.revoke(actor.sessionId!, actor.id, 'LOGOUT', new Date()));
  }

  /** Sets the first password of an invited user. The token is single-use and expires (IAM_INVITE_TTL_HOURS). */
  async acceptInvitation(input: AcceptInvitationInput): Promise<{ userId: string }> {
    const now = new Date();
    return this.tx.run(async () => {
      const claimed = await this.repo.claimInvitation(sha256Hex(input.token), now);
      if (!claimed) throw new AppError('iam.invitation.invalid', HttpStatus.BAD_REQUEST);
      const user = await this.repo.userById(claimed.userId);
      if (!user || user.status === 'DISABLED')
        throw new AppError('iam.invitation.invalid', HttpStatus.BAD_REQUEST);
      await this.assertPasswordPolicy(input.password, user.email, user.tenantId);
      await this.repo.updateUser(user.id, {
        passwordHash: await hashPassword(input.password),
        passwordChangedAt: now,
        status: 'ACTIVE',
        failedLoginCount: 0,
        lockedUntil: null,
      });
      await this.audit.record({
        action: 'iam.invitation.accept',
        entityType: 'user',
        entityId: user.id,
        tenantId: user.tenantId,
        actor: { type: staffActorType(user), id: user.id },
        before: { status: user.status },
        after: { status: 'ACTIVE' },
      });
      return { userId: user.id };
    });
  }

  /** Starts TOTP enrolment: stores the sealed seed (not yet active) and returns it once for the authenticator app. */
  async enrollMfa(actor: RequestActor): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.requireSelf(actor);
    if (user.mfaEnabled) throw AppError.conflict('iam.auth.mfa_already_enabled');
    const secret = generateTotpSecret();
    await this.tx.run(async () => {
      await this.repo.updateUser(user.id, {
        mfaSecretEnc: seal(secret, this.keys.mfaSealingKey),
        mfaLastStep: null,
      });
      await this.audit.record({
        action: 'iam.mfa.enroll',
        entityType: 'user',
        entityId: user.id,
        tenantId: user.tenantId,
      });
    });
    return { secret, otpauthUri: otpauthUri(secret, this.config.iam.issuer, user.email) };
  }

  async activateMfa(actor: RequestActor, code: string): Promise<{ mfaEnabled: true }> {
    const user = await this.requireSelf(actor);
    if (user.mfaEnabled) throw AppError.conflict('iam.auth.mfa_already_enabled');
    if (!user.mfaSecretEnc) throw AppError.conflict('iam.auth.mfa_not_enrolled');
    const secret = unseal(user.mfaSecretEnc, this.keys.mfaSealingKey);
    const step = verifyTotp(secret, code, Date.now(), user.mfaLastStep);
    if (step === null || !(await this.repo.claimMfaStep(user.id, step)))
      throw new AppError('iam.auth.invalid_mfa_code', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.tx.run(async () => {
      await this.repo.updateUser(user.id, { mfaEnabled: true });
      await this.audit.record({
        action: 'iam.mfa.activate',
        entityType: 'user',
        entityId: user.id,
        tenantId: user.tenantId,
        before: { mfaEnabled: false },
        after: { mfaEnabled: true },
      });
    });
    return { mfaEnabled: true };
  }

  /** Length policy with the tenant's configured minimum (`iam.password.min_length`, never below the platform floor). */
  async assertPasswordPolicy(
    password: string,
    email: string,
    tenantId: string | null,
  ): Promise<void> {
    const min = Math.max(
      PASSWORD_MIN_LENGTH,
      (await this.settings.effective(IAM_PASSWORD_MIN_LENGTH, { tenantId })).value,
    );
    const problem = checkPasswordPolicy(password, email, min);
    if (problem)
      throw new AppError(`iam.password.${problem}`, HttpStatus.UNPROCESSABLE_ENTITY, {
        min,
        max: PASSWORD_MAX_LENGTH,
      });
  }

  /** Revokes one session and announces it (realtime connections close on the event). Call inside a transaction. */
  async revoke(sessionId: string, userId: string, reason: RevokeReason, now: Date): Promise<void> {
    if (!(await this.repo.revokeSession(sessionId, reason, now))) return;
    const session = await this.repo.sessionById(sessionId);
    await this.events.publish(SessionRevoked, {
      tenantId: session?.tenantId ?? null,
      source: 'iam',
      aggregate: { type: 'session', id: sessionId },
      payload: { session_id: sessionId, user_id: userId, reason },
    });
    await this.audit.record({
      action: 'iam.session.revoke',
      entityType: 'session',
      entityId: sessionId,
      tenantId: session?.tenantId ?? null,
      propertyId: null,
      reason,
      after: { userId },
    });
  }

  private async openSession(
    user: UserRow,
    meta: ClientMeta,
    mfaVerified: boolean,
    now: Date,
  ): Promise<IssuedTokens> {
    const person = await this.repo.personById(user.personId);
    const { session, refreshToken, refreshExpiresAt } = await this.tx.run(async () => {
      await this.repo.updateUser(user.id, {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
      });
      const started = await this.tokens.startSession(user, { ...meta, mfaVerified }, now);
      await this.audit.record({
        action: 'iam.session.create',
        entityType: 'session',
        entityId: started.session.id,
        tenantId: user.tenantId,
        propertyId: null,
        actor: { type: staffActorType(user), id: user.id },
        after: { userId: user.id, mfaVerified, ip: meta.ip, userAgent: meta.userAgent },
      });
      return started;
    });
    const access = await this.tokens.signAccess({
      userId: user.id,
      tenantId: user.tenantId,
      sessionId: session.id,
      isPlatformAdmin: user.isPlatformAdmin,
      locale: person?.localePref ?? null,
    });
    return {
      accessToken: access.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      refreshToken,
      refreshExpiresAt: refreshExpiresAt.toISOString(),
      sessionId: session.id,
    };
  }

  /** Counts a failed password/MFA attempt (outside any request transaction so the error path cannot roll it back). */
  private async recordFailure(user: UserRow, now: Date): Promise<void> {
    const count = await this.repo.recordLoginFailure(user.id);
    if (count >= this.config.iam.loginMaxAttempts) {
      const lockedUntil = new Date(now.getTime() + this.config.iam.loginLockMinutes * 60_000);
      await this.repo.updateUser(user.id, { failedLoginCount: 0, lockedUntil });
      await this.audit.record({
        action: 'iam.user.lock',
        entityType: 'user',
        entityId: user.id,
        tenantId: user.tenantId,
        propertyId: null,
        actor: { type: 'SYSTEM', id: null },
        reason: 'too_many_failed_attempts',
        after: { lockedUntil },
        allowAutocommit: true,
      });
    }
  }

  private async requireSelf(actor: RequestActor): Promise<UserRow> {
    const user = await this.repo.userById(actor.id);
    if (!user || user.status !== 'ACTIVE')
      throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);
    return user;
  }
}
