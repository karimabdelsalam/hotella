import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticationStrategy, RequestActor } from '@hotella/platform-auth';
import type { LocalePreferenceProvider } from '@hotella/platform-i18n';
import { TokenService } from '../application/token.service';
import { IdentityRepositories } from '../infrastructure/repositories';

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/**
 * Staff authentication: a valid access token AND a live session for an ACTIVE user (so logout, refresh-token reuse,
 * disabling a user or PMS-driven revocation take effect on the next request, not at token expiry).
 */
@Injectable()
export class JwtAuthenticationStrategy implements AuthenticationStrategy {
  constructor(
    private readonly tokens: TokenService,
    private readonly repo: IdentityRepositories,
  ) {}

  async authenticate(req: Request): Promise<RequestActor | null> {
    const token = bearerToken(req);
    if (!token) return null;
    const claims = await this.tokens.verifyAccess(token);
    if (!claims) return null;
    const live = await this.repo.liveSession(claims.sessionId, new Date());
    if (!live || live.user.id !== claims.userId) return null;
    return {
      type: 'USER',
      id: live.user.id,
      tenantId: live.user.tenantId,
      isPlatformAdmin: live.user.isPlatformAdmin,
      locale: live.person.localePref ?? null,
      sessionId: live.session.id,
    };
  }
}

/** Locale chain step "user preference" (Spec §79.3), read from the token claim without a database round trip. */
@Injectable()
export class IdentityLocalePreferences implements LocalePreferenceProvider {
  constructor(private readonly tokens: TokenService) {}
  async actorPreference(req: Request): Promise<string | null> {
    const token = bearerToken(req);
    if (!token) return null;
    return (await this.tokens.verifyAccess(token))?.locale ?? null;
  }
  propertyDefault(): string | null {
    return null;
  }
}
