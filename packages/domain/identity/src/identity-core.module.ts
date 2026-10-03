import { Global, Module } from '@nestjs/common';
import { TokenService } from './application/token.service';
import { MembershipPermissionResolver } from './auth/permission-resolver';
import { IdentityLocalePreferences, JwtAuthenticationStrategy } from './auth/strategy';
import { IdentityKeys } from './infrastructure/keys';
import { IdentityRepositories } from './infrastructure/repositories';

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
