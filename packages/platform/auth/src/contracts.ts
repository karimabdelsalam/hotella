import type { Request } from 'express';
import type { RequestActor } from './actor';

/** Turns credentials on the request (bearer token, guest session, API key) into an actor. Implemented by the identity context. */
export interface AuthenticationStrategy {
  authenticate(req: Request): Promise<RequestActor | null>;
}
export const AUTHENTICATION_STRATEGY = Symbol('AUTHENTICATION_STRATEGY');

export interface PermissionScope {
  readonly tenantId: string | null;
  readonly propertyId?: string | null;
}

/** Membership → Role → Permission resolution for a property (Spec §5). Implemented by the identity context. */
export interface PermissionResolver {
  hasPermission(actor: RequestActor, permission: string, scope: PermissionScope): Promise<boolean>;
  /** Effective permission codes for the actor in a scope (for /me and UIs). */
  permissionsFor(actor: RequestActor, scope: PermissionScope): Promise<readonly string[]>;
}
export const PERMISSION_RESOLVER = Symbol('PERMISSION_RESOLVER');

/** Nobody is authenticated; used until the identity context wires a real strategy. */
export class AnonymousStrategy implements AuthenticationStrategy {
  async authenticate(): Promise<RequestActor | null> {
    return null;
  }
}

/** Denies everything except platform admins; the safe default. */
export class DenyAllResolver implements PermissionResolver {
  async hasPermission(actor: RequestActor): Promise<boolean> {
    return actor.isPlatformAdmin;
  }
  async permissionsFor(): Promise<readonly string[]> {
    return [];
  }
}
