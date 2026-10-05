import {
  EntitlementsChanged,
  LimitReached,
  PlanVersionPublished,
  SubscriptionChanged,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const LICENSING_MANIFEST = defineManifest({
  code: 'license',
  schema: 'license',
  description:
    'Licensing & entitlements: the commercial catalog (modules, AI and connector entitlements, add-ons, metrics), plans with immutable versions, subscriptions, grants, limits and usage; EntitlementEngine.can answers every other context.',
  permissions: [
    {
      code: 'license.catalog.read',
      descriptionKey: 'license.permission.catalog_read',
      risk: 'READ',
    },
    { code: 'license.plan.manage', descriptionKey: 'license.permission.plan_manage', risk: 'HIGH' },
    {
      code: 'license.subscription.manage',
      descriptionKey: 'license.permission.subscription_manage',
      risk: 'HIGH',
    },
    {
      code: 'license.grant.manage',
      descriptionKey: 'license.permission.grant_manage',
      risk: 'HIGH',
    },
    {
      code: 'license.entitlement.read',
      descriptionKey: 'license.permission.entitlement_read',
      risk: 'READ',
    },
    { code: 'license.tenant.read', descriptionKey: 'license.permission.tenant_read', risk: 'READ' },
    { code: 'license.usage.read', descriptionKey: 'license.permission.usage_read', risk: 'READ' },
    {
      code: 'license.installation.manage',
      descriptionKey: 'license.permission.installation_manage',
      risk: 'HIGH',
    },
    {
      code: 'license.attribution.manage',
      descriptionKey: 'license.permission.attribution_manage',
      risk: 'HIGH',
    },
  ],
  events: [
    PlanVersionPublished.name,
    SubscriptionChanged.name,
    EntitlementsChanged.name,
    LimitReached.name,
  ],
  localeNamespaces: ['license'],
});
