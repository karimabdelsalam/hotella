import { Global, Module } from '@nestjs/common';
import { TokenService } from './application/token.service';
import { MembershipPermissionResolver } from './auth/permission-resolver';
import { IdentityLocalePreferences, JwtAuthenticationStrategy } from './auth/strategy';
import { IdentityKeys } from './infrastructure/keys';
import { IdentityRepositories } from './infrastructure/repositories';
import { IDENTITY_API } from './public';
import { IdentityPublicApiService } from './public-api.service';
import { IdentityUsageGauge } from './application/usage-gauge';
import { ApiKeyAuthenticator } from './auth/api-key.authenticator';

/**
 * What platform-auth and platform-i18n need from identity, with no dependency back on them: key material,
 * tokens, the authentication strategy, the permission resolver and the locale preference. Global so AuthModule and
 * I18nModule can alias these providers (`useExisting`) without importing the full identity module.
 */
@Global()
@Module({
  providers: [
    IdentityRepositories,
    IdentityKeys,
    TokenService,
    ApiKeyAuthenticator,
    JwtAuthenticationStrategy,
    MembershipPermissionResolver,
    IdentityLocalePreferences,
  ],
  exports: [
    IdentityRepositories,
    IdentityKeys,
    TokenService,
    JwtAuthenticationStrategy,
    MembershipPermissionResolver,
    IdentityLocalePreferences,
  ],
})
export class IdentityCoreModule {}

/**
 * IDENTITY_API for background processes (the worker): staff lookups without HTTP routes, keys or authentication.
 * The API process gets IDENTITY_API from IdentityModule; never import both in one application.
 */
@Global()
@Module({
  providers: [
    IdentityRepositories,
    IdentityPublicApiService,
    { provide: IDENTITY_API, useExisting: IdentityPublicApiService },
    IdentityUsageGauge,
  ],
  exports: [IDENTITY_API],
})
export class IdentityDirectoryModule {}
