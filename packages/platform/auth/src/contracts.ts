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

/**
 * Confirms a property belongs to a tenant, so a tenant user naming another tenant's (or a non-existent) property gets
 * 404 before any permission check — cross-tenant probing never learns more than "not found" (CLAUDE.md rule 1).
 * Implemented by the organization context.
 */
export interface PropertyScopeVerifier {
  propertyBelongsToTenant(propertyId: string, tenantId: string): Promise<boolean>;
}
export const PROPERTY_SCOPE_VERIFIER = Symbol('PROPERTY_SCOPE_VERIFIER');

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
