import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUEST_API, type GuestPrincipal, type GuestScope } from './tokens';
import { ActorStore } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';

/** Header carrying the opaque guest session token (staff use `Authorization: Bearer`). */
export const GUEST_SESSION_HEADER = 'x-guest-session';
const GUEST_SCOPE_KEY = 'hotella:guest-scope';

/** The guest scope a route needs (Spec §21); checked against the grant on every request. */
export const RequireGuestScope = (scope: GuestScope): MethodDecorator & ClassDecorator =>
  SetMetadata(GUEST_SCOPE_KEY, scope);

/** The one GUEST_API call the guard makes (typed here to keep this file independent of the full API). */
interface SessionAuthenticator {
  authenticateGuestSession(token: string): Promise<GuestPrincipal | null>;
}

/** The part of the HTTP request the guard needs (no dependency on the HTTP framework's types). */
interface GuestRequest {
  header(name: string): string | undefined;
  guestPrincipal?: GuestPrincipal;
}

/** The authenticated guest of the request (set by GuestSessionGuard). */
export const CurrentGuest = createParamDecorator(
  (_: unknown, context: ExecutionContext): GuestPrincipal => {
    const principal = context.switchToHttp().getRequest<GuestRequest>().guestPrincipal;
    if (!principal) throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);
    return principal;
  },
);

/**
 * Guest authentication (ADR-0011): resolves the session token through the guest context on every request — session
 * live, grant unrevoked and inside its validity, scope present — and publishes a GUEST actor scoped to the grant's
 * tenant and property. The phone or channel identity is never enough (Spec §18.3).
 */
@Injectable()
export class GuestSessionGuard implements CanActivate {
  constructor(
    @Inject(GUEST_API) private readonly guests: SessionAuthenticator,
    private readonly actors: ActorStore,
    private readonly ctx: RequestContext,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GuestRequest>();
    const token = req.header(GUEST_SESSION_HEADER);
    const principal = token ? await this.guests.authenticateGuestSession(token) : null;
    if (!principal) throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);
    const needed = this.reflector.getAllAndOverride<GuestScope | undefined>(GUEST_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (needed && !principal.scopes.includes(needed))
      throw AppError.forbidden('guest.session.scope_missing', { scope: needed });
    req.guestPrincipal = principal;
    this.actors.set({
      type: 'GUEST',
      id: principal.guestId,
      tenantId: principal.tenantId,
      isPlatformAdmin: false,
    });
    this.ctx.setScope({
      tenantId: principal.tenantId,
      propertyId: principal.propertyId,
      actor: { type: 'GUEST', id: principal.guestId },
    });
    return true;
  }
}
