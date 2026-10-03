import { Global, Module } from '@nestjs/common';
import { AttributionPolicyService } from './attribution.service';
import { ConfigurationService } from './configuration.service';
import { SettingsRegistry } from './registry';
import { RetentionPolicyService } from './retention.service';
import { ConfigurationController, RetentionPoliciesController } from './settings.controller';

/**
 * Configuration, retention and attribution (declared in PLATFORM_MANIFEST: config.read, config.manage,
 * platform.configuration.changed.v1). Modules register their settings in onModuleInit via SettingsRegistry.
 */
@Global()
@Module({
  controllers: [ConfigurationController, RetentionPoliciesController],
  providers: [
    SettingsRegistry,
    ConfigurationService,
    RetentionPolicyService,
    AttributionPolicyService,
  ],
  exports: [
    SettingsRegistry,
    ConfigurationService,
    RetentionPolicyService,
    AttributionPolicyService,
  ],
})
export class SettingsModule {}
