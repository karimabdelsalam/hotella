import { FeatureFlagChanged, PlatformPing } from '@hotella/contracts-events';
import { defineManifest } from './manifest';

/** The platform itself declares what it exposes, like any bounded context will. */
export const PLATFORM_MANIFEST = defineManifest({
  code: 'platform',
  schema: 'platform',
  description: 'Cross-cutting platform infrastructure: feature flags, outbox/inbox, scheduler.',
  permissions: [
    {
      code: 'platform.feature_flag.read',
      descriptionKey: 'platform.permission.feature_flag_read',
      risk: 'READ',
    },
    {
      code: 'platform.feature_flag.manage',
      descriptionKey: 'platform.permission.feature_flag_manage',
      risk: 'HIGH',
    },
    {
      code: 'platform.outbox.read',
      descriptionKey: 'platform.permission.outbox_read',
      risk: 'READ',
    },
    {
      code: 'platform.outbox.replay',
      descriptionKey: 'platform.permission.outbox_replay',
      risk: 'HIGH',
    },
  ],
  events: [PlatformPing.name, FeatureFlagChanged.name],
  localeNamespaces: ['common', 'errors'],
});
