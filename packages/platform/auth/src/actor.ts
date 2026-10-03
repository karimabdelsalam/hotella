import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { ActorType } from '@hotella/platform-observability';

/**
 * Who is acting. Resolved once per request by the AuthenticationStrategy and kept in CLS.
 * Platform staff have `tenantId: null` and act on tenants named in the route; tenant users are bound to one tenant.
 */
export interface RequestActor {
  readonly type: ActorType;
  readonly id: string;
  readonly tenantId: string | null;
  /** Platform-level administrator (Spec §63): may manage tenants but has no standing access to guest data (§64). */
  readonly isPlatformAdmin: boolean;
  /** Preferred locale from the profile, when known. */
  readonly locale?: string | null;
}

const CLS_ACTOR_KEY = 'request_actor';

@Injectable()
export class ActorStore {
  constructor(private readonly cls: ClsService) {}
  set(actor: RequestActor | null): void {
    if (this.cls.isActive()) this.cls.set(CLS_ACTOR_KEY, actor);
  }
  get(): RequestActor | null {
    return this.cls.isActive() ? (this.cls.get<RequestActor | null>(CLS_ACTOR_KEY) ?? null) : null;
  }
  /** The actor, or throws 401 — for application services that must never run anonymously. */
  require(): RequestActor {
    const a = this.get();
    if (!a) throw new UnauthenticatedError();
    return a;
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('platform.unauthorized');
    this.name = 'UnauthenticatedError';
  }
}
