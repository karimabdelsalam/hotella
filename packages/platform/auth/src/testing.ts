import type { Request } from 'express';
import type { RequestActor } from './actor';
import type { AuthenticationStrategy, PermissionResolver, PermissionScope } from './contracts';

/**
 * TEST ONLY. Reads a JSON RequestActor from `X-Test-Actor`. Wire it only when NODE_ENV=test; the API module
 * refuses it otherwise.
 */
export class HeaderActorStrategy implements AuthenticationStrategy {
  async authenticate(req: Request): Promise<RequestActor | null> {
    const raw = req.headers['x-test-actor'];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (!v) return null;
    const parsed = JSON.parse(v) as Partial<RequestActor>;
    return {
      type: parsed.type ?? 'USER',
      id: parsed.id ?? 'test-user',
      tenantId: parsed.tenantId ?? null,
      isPlatformAdmin: parsed.isPlatformAdmin ?? false,
      locale: parsed.locale ?? null,
    };
  }
}

/** TEST ONLY. `grants[actorId]` = list of `permission` or `permission@propertyId`; `*` grants everything. */
export class StaticPermissionResolver implements PermissionResolver {
  constructor(private readonly grants: Record<string, readonly string[]>) {}
  async hasPermission(
    actor: RequestActor,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    if (actor.isPlatformAdmin) return true;
    const list = this.grants[actor.id] ?? [];
    return (
      list.includes('*') ||
      list.includes(permission) ||
      (scope.propertyId ? list.includes(`${permission}@${scope.propertyId}`) : false)
    );
  }
  async permissionsFor(actor: RequestActor, scope: PermissionScope): Promise<readonly string[]> {
    const list = this.grants[actor.id] ?? [];
    return list
      .filter(
        (g) => !g.includes('@') || (scope.propertyId ? g.endsWith(`@${scope.propertyId}`) : false),
      )
      .map((g) => g.split('@')[0]!);
  }
}
