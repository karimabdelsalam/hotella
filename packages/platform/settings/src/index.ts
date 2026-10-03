export { attributionFor, PLANOVA_ATTRIBUTION } from './attribution';
export type { Attribution } from './attribution';
export { AttributionPolicyService } from './attribution.service';
export { ConfigurationService } from './configuration.service';
export type { ScopeTarget } from './configuration.service';
export {
  defineSetting,
  resolveEffective,
  SCOPE_ORDER,
  SETTING_KEY_RE,
  SettingsRegistry,
} from './registry';
export type { ConfigScope, EffectiveValue, SettingDefinition, StoredValue } from './registry';
export { RetentionPolicyService } from './retention.service';
export type { RetentionPolicyInput } from './retention.service';
export { SettingsModule } from './settings.module';
export * as settingsSchema from './schema/settings';
