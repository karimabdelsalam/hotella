import { Inject, Injectable } from '@nestjs/common';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { newId } from '@hotella/platform-database';
import { generateOpaqueToken, sha256Hex } from '../domain/tokens';
import { IdentityKeys } from '../infrastructure/keys';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { SessionRow, UserRow } from '../infrastructure/schema';

export const ACCESS_AUDIENCE = 'hotella-staff';
const MFA_CHALLENGE_TTL_SECONDS = 300;

export interface AccessClaims {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly sessionId: string;
  readonly isPlatformAdmin: boolean;
  readonly locale: string | null;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly sessionId: string;
}

export type RotationResult =
  | {
      readonly kind: 'ok';
      readonly session: SessionRow;
      readonly refreshToken: string;
      readonly refreshExpiresAt: Date;
    }
  | { readonly kind: 'reuse'; readonly sessionId: string; readonly userId: string }
  | { readonly kind: 'invalid' };

/**
 * ADR-0011 token mechanics. Access: EdDSA JWT ≤ 15 min, no permissions inside (resolved per request).
 * Refresh: opaque 256-bit, stored as SHA-256, single use; presenting a used token revokes the whole session.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly keys: IdentityKeys,
    private readonly repo: IdentityRepositories,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    const { privateKey, kid } = this.keys.signingKey;
    const ttl = this.config.iam.accessTokenTtlSeconds;
    const token = await new SignJWT({
      typ: 'access',
      tid: claims.tenantId,
      sid: claims.sessionId,
      adm: claims.isPlatformAdmin,
      loc: claims.locale,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject(claims.userId)
      .setIssuer(this.config.iam.issuer)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt()
      .setJti(newId())
      .setExpirationTime(`${ttl}s`)
      .sign(privateKey);
    return { token, expiresIn: ttl };
  }

  /** Signature, issuer, audience, expiry and type; returns null for anything else (never throws on bad input). */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys.signingKey.publicKey, {
        issuer: this.config.iam.issuer,
        audience: ACCESS_AUDIENCE,
        algorithms: ['EdDSA'],
      });
      if (payload['typ'] !== 'access' || typeof payload.sub !== 'string') return null;
      const sid = payload['sid'];
      if (typeof sid !== 'string') return null;
      const tid = payload['tid'];
      const loc = payload['loc'];
      return {
        userId: payload.sub,
        tenantId: typeof tid === 'string' ? tid : null,
        sessionId: sid,
        isPlatformAdmin: payload['adm'] === true,
        locale: typeof loc === 'string' ? loc : null,
      };
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) return null;
      throw err;
    }
  }

  /** Short-lived proof that the password step passed; exchanged with a TOTP code for a session. */
  async signMfaChallenge(userId: string): Promise<string> {
    const { privateKey, kid } = this.keys.signingKey;
    return new SignJWT({ typ: 'mfa_challenge' })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setSubject(userId)
      .setIssuer(this.config.iam.issuer)
      .setAudience(`${ACCESS_AUDIENCE}:mfa`)
      .setIssuedAt()
      .setExpirationTime(`${MFA_CHALLENGE_TTL_SECONDS}s`)
      .sign(privateKey);
  }

  async verifyMfaChallenge(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.keys.signingKey.publicKey, {
        issuer: this.config.iam.issuer,
        audience: `${ACCESS_AUDIENCE}:mfa`,
        algorithms: ['EdDSA'],
      });
      return payload['typ'] === 'mfa_challenge' && typeof payload.sub === 'string'
        ? payload.sub
        : null;
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) return null;
      throw err;
    }
  }

  /** Creates a session (refresh-token family) and its first refresh token. Call inside a transaction. */
  async startSession(
    user: UserRow,
    meta: { ip: string | null; userAgent: string | null; mfaVerified: boolean },
    now: Date,
  ): Promise<{ session: SessionRow; refreshToken: string; refreshExpiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + this.config.iam.refreshTokenTtlDays * 86_400_000);
    const session = await this.repo.insertSession({
      id: newId(),
      tenantId: user.tenantId,
      userId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      mfaVerified: meta.mfaVerified,
      expiresAt,
      lastUsedAt: now,
    });
    const refreshToken = generateOpaqueToken('rt');
    await this.repo.insertRefreshToken({
      id: newId(),
      sessionId: session.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt,
    });
    return { session, refreshToken, refreshExpiresAt: expiresAt };
  }

  /** Single-use rotation with reuse detection. Call inside a transaction. */
  async rotate(presented: string, now: Date): Promise<RotationResult> {
    if (!presented.startsWith('rt_')) return { kind: 'invalid' };
    const row = await this.repo.refreshTokenByHash(sha256Hex(presented));
    if (!row) return { kind: 'invalid' };
    const session = await this.repo.sessionById(row.sessionId);
    if (!session) return { kind: 'invalid' };
    if (row.usedAt) return { kind: 'reuse', sessionId: session.id, userId: session.userId };
    if (session.revokedAt || session.expiresAt <= now || row.expiresAt <= now)
      return { kind: 'invalid' };
    const nextId = newId();
    const refreshToken = generateOpaqueToken('rt');
    // Insert the successor first so the replaced_by FK is satisfiable, then claim the presented token atomically.
    await this.repo.insertRefreshToken({
      id: nextId,
      sessionId: session.id,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: session.expiresAt,
    });
    if (!(await this.repo.claimRefreshToken(row.id, nextId, now)))
      return { kind: 'reuse', sessionId: session.id, userId: session.userId };
    await this.repo.touchSession(session.id, now);
    return { kind: 'ok', session, refreshToken, refreshExpiresAt: session.expiresAt };
  }
}
