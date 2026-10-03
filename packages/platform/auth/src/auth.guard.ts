import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { ActorStore } from './actor';
import {
  AUTHENTICATION_STRATEGY,
  type AuthenticationStrategy,
  PERMISSION_RESOLVER,
  type PermissionResolver,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
} from './contracts';
import {
  PERMISSION_CHECK_KEY,
  PERMISSION_KEY,
  PROPERTY_SCOPE_KEY,
  PUBLIC_KEY,
  type ScopeSource,
  TENANT_SCOPE_KEY,
} from './decorators';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Global guard: authenticate → publish the actor to CLS → resolve the scope named by the route →
 * check the permission for that scope. Anonymous on a protected route → 401; missing permission → 403.
 * Cross-tenant ids are never confirmed here: a tenant user naming another tenant gets 404-shaped behaviour
 * downstream because repositories filter by the actor's tenant.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly actors: ActorStore,
    private readonly ctx: RequestContext,
    @Inject(AUTHENTICATION_STRATEGY) private readonly strategy: AuthenticationStrategy,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
    @Optional()
    @Inject(PROPERTY_SCOPE_VERIFIER)
    private readonly properties?: PropertyScopeVerifier | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets) ?? false;

    const actor = await this.strategy.authenticate(req);
    this.actors.set(actor);
    if (actor)
      this.ctx.setScope({ tenantId: actor.tenantId, actor: { type: actor.type, id: actor.id } });
    if (isPublic) return true;
    if (!actor) throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);

    const tenantSource = this.reflector.getAllAndOverride<ScopeSource | undefined>(
      TENANT_SCOPE_KEY,
      targets,
    );
    const propertySource = this.reflector.getAllAndOverride<ScopeSource | undefined>(
      PROPERTY_SCOPE_KEY,
      targets,
    );

    let tenantId = actor.tenantId;
    if (tenantSource) {
      const named = readId(req, tenantSource);
      if (!named)
        throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
      if (actor.tenantId && actor.tenantId !== named) throw AppError.notFound(); // never confirm another tenant exists
      tenantId = named;
    }
    const propertyId = propertySource ? readId(req, propertySource) : null;
    if (propertySource && !propertyId && !propertySource.optional)
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
    // A tenant user naming a property outside their tenant (or one that does not exist) gets 404, never 403.
    if (propertyId && actor.tenantId && this.properties) {
      if (!(await this.properties.propertyBelongsToTenant(propertyId, actor.tenantId)))
        throw AppError.notFound('org.property.not_found');
    }
    this.ctx.setScope({ tenantId, propertyId });

    const permission = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_KEY,
      targets,
    );
    if (!permission) return true;
    const checkedBy = this.reflector.getAllAndOverride<'guard' | 'gate' | undefined>(
      PERMISSION_CHECK_KEY,
      targets,
    );
    if (checkedBy === 'gate') return true;
    const allowed = await this.permissions.hasPermission(actor, permission, {
      tenantId,
      propertyId,
    });
    if (!allowed) throw AppError.forbidden('platform.forbidden', { permission });
    return true;
  }
}

function readId(req: Request, source: ScopeSource): string | null {
  const key = source.key ?? 'propertyId';
  const candidates: unknown[] =
    source.from === 'param'
      ? [req.params[key]]
      : source.from === 'query'
        ? [req.query[key]]
        : source.from === 'body'
          ? [(req.body as Record<string, unknown> | undefined)?.[key]]
          : [
              req.params[key],
              req.query[key],
              (req.body as Record<string, unknown> | undefined)?.[key],
            ];
  const found = candidates.find((v) => typeof v === 'string' && UUID_RE.test(v));
  return (found as string | undefined) ?? null;
}
