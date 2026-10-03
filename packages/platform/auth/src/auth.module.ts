import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ActionGate } from './action-gate';
import { ActorStore } from './actor';
import { AuthGuard } from './auth.guard';
import {
  AnonymousStrategy,
  AUTHENTICATION_STRATEGY,
  DenyAllResolver,
  PERMISSION_RESOLVER,
  PROPERTY_SCOPE_VERIFIER,
} from './contracts';

export interface AuthModuleOptions {
  /** Provider for AUTHENTICATION_STRATEGY (identity context in Phase 1.2). Default: nobody is authenticated. */
  readonly strategy?: Provider;
  /** Provider for PERMISSION_RESOLVER (identity context). Default: deny all but platform admins. */
  readonly resolver?: Provider;
  /** Extra gate stages (entitlement, configuration, connector capability, AI policy). */
  readonly stages?: Provider[];
  /** Provider for PROPERTY_SCOPE_VERIFIER (organization context): foreign/unknown property → 404 before permissions. */
  readonly propertyVerifier?: Provider;
  /**
   * Install the AuthGuard on every HTTP route (default). Processes that only need the ActionGate for background work
   * (the worker, whose own routes are operational health checks) pass false.
   */
  readonly httpGuard?: boolean;
}

@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        ActorStore,
        ActionGate,
        options.strategy ?? { provide: AUTHENTICATION_STRATEGY, useClass: AnonymousStrategy },
        options.resolver ?? { provide: PERMISSION_RESOLVER, useClass: DenyAllResolver },
        ...(options.stages ?? []),
        options.propertyVerifier ?? { provide: PROPERTY_SCOPE_VERIFIER, useValue: null },
        ...(options.httpGuard === false ? [] : [{ provide: APP_GUARD, useClass: AuthGuard }]),
      ],
      exports: [
        ActorStore,
        ActionGate,
        AUTHENTICATION_STRATEGY,
        PERMISSION_RESOLVER,
        PROPERTY_SCOPE_VERIFIER,
      ],
    };
  }
}
