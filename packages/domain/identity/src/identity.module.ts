import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  AUTHENTICATION_STRATEGY,
  type AuthModuleOptions,
  PERMISSION_RESOLVER,
} from '@hotella/platform-auth';
import { LOCALE_PREFERENCE_PROVIDER } from '@hotella/platform-i18n';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { SettingsRegistry } from '@hotella/platform-settings';
import { IDENTITY_SETTINGS } from './domain/settings';
import {
  AuthController,
  MeController,
  PermissionsController,
  SupportAccessController,
  TenantIdentityController,
} from './api/controllers';
import { SupportAccessService } from './application/support-access.service';
import { SupportAccessAuditInterceptor } from './auth/support-audit.interceptor';
import { IdentityAdminService } from './application/admin.service';
import { AuthService } from './application/auth.service';
import { IdentityBootstrapService } from './application/bootstrap.service';
import { IdentityCatalogService } from './application/catalog.service';
import { ProfileService } from './application/profile.service';
import { MembershipPermissionResolver } from './auth/permission-resolver';
import { IdentityLocalePreferences, JwtAuthenticationStrategy } from './auth/strategy';
import { IDENTITY_MANIFEST } from './manifest';
import { IDENTITY_API } from './public';
import { IdentityPublicApiService } from './public-api.service';

/** Global so other contexts can inject IDENTITY_API. Needs ORGANIZATION_API (OrganizationModule) in the app. */
@Global()
@Module({
  controllers: [
    AuthController,
    MeController,
    PermissionsController,
    SupportAccessController,
    TenantIdentityController,
  ],
  providers: [
    AuthService,
    IdentityAdminService,
    ProfileService,
    IdentityCatalogService,
    IdentityBootstrapService,
    IdentityPublicApiService,
    SupportAccessService,
    { provide: APP_INTERCEPTOR, useClass: SupportAccessAuditInterceptor },
    { provide: IDENTITY_API, useExisting: IdentityPublicApiService },
  ],
  exports: [IDENTITY_API, IdentityBootstrapService, IdentityCatalogService],
})
export class IdentityModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(IDENTITY_MANIFEST);
    this.settings.register(...IDENTITY_SETTINGS);
  }
}

/** `AuthModule.forRoot(identityAuthOptions())` — the real strategy and resolver (requires IdentityCoreModule). */
export function identityAuthOptions(): AuthModuleOptions {
  return {
    strategy: { provide: AUTHENTICATION_STRATEGY, useExisting: JwtAuthenticationStrategy },
    resolver: { provide: PERMISSION_RESOLVER, useExisting: MembershipPermissionResolver },
  };
}

/** `I18nModule.forRoot({ preferences: identityLocalePreferences() })` — the user-preference step of the locale chain. */
export function identityLocalePreferences() {
  return { provide: LOCALE_PREFERENCE_PROVIDER, useExisting: IdentityLocalePreferences };
}
