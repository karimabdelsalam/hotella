export {
  ActionGate,
  AI_POLICY_STAGE,
  CONFIGURATION_STAGE,
  CONNECTOR_CAPABILITY_STAGE,
  ENTITLEMENT_STAGE,
  PassThroughStage,
} from './action-gate';
export type { ActionRequest, GateStage } from './action-gate';
export { ActorStore, UnauthenticatedError } from './actor';
export type { RequestActor } from './actor';
export { AuthGuard } from './auth.guard';
export { AuthModule } from './auth.module';
export type { AuthModuleOptions } from './auth.module';
export {
  AnonymousStrategy,
  AUTHENTICATION_STRATEGY,
  DenyAllResolver,
  PERMISSION_RESOLVER,
  PROPERTY_SCOPE_VERIFIER,
} from './contracts';
export type {
  AuthenticationStrategy,
  PermissionResolver,
  PermissionScope,
  PropertyScopeVerifier,
} from './contracts';
export {
  PERMISSION_CHECK_KEY,
  PERMISSION_KEY,
  PROPERTY_SCOPE_KEY,
  PropertyScoped,
  Public,
  PUBLIC_KEY,
  RequirePermission,
  TENANT_SCOPE_KEY,
  TenantScoped,
} from './decorators';
export type { RequirePermissionOptions, ScopeSource } from './decorators';
export { HeaderActorStrategy, StaticPermissionResolver } from './testing';
