import { Global, Module } from '@nestjs/common';
import { AttributionPolicyService } from './attribution.service';
import { ConfigurationService } from './configuration.service';
import { SettingsRegistry } from './registry';
import { RetentionPolicyService } from './retention.service';
import { SettingsReader } from './settings-reader';
import { ConfigurationController, RetentionPoliciesController } from './settings.controller';

/** Setting definitions and effective values, without routes (the worker reads property policy through it). */
@Global()
@Module({
  providers: [SettingsRegistry, SettingsReader],
  exports: [SettingsRegistry, SettingsReader],
})
export class SettingsCoreModule {}

/**
 * Configuration, retention and attribution (declared in PLATFORM_MANIFEST: config.read, config.manage,
 * platform.configuration.changed.v1). Modules register their settings in onModuleInit via SettingsRegistry.
 */
@Global()
@Module({
  imports: [SettingsCoreModule],
  controllers: [ConfigurationController, RetentionPoliciesController],
  providers: [ConfigurationService, RetentionPolicyService, AttributionPolicyService],
  exports: [ConfigurationService, RetentionPolicyService, AttributionPolicyService],
})
export class SettingsModule {}
