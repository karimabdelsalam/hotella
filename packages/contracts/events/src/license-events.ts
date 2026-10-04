import { z } from 'zod';
import { defineEvent } from './registry';

/** Licensing events (Spec §58–§62, BUILD_PLAN Phase 11): codes and ids only, never commercial terms or amounts. */

export const PlanVersionPublished = defineEvent({
  type: 'license.plan_version.published',
  version: 1,
  description:
    'A plan version was published; it is immutable from now on and tenants can be subscribed to it.',
  payload: z.object({
    plan_id: z.uuid(),
    plan_code: z.string(),
    plan_version_id: z.uuid(),
    version_no: z.number().int().min(1),
    capabilities: z.array(z.string()),
  }),
});

export const SubscriptionChanged = defineEvent({
  type: 'license.subscription.changed',
  version: 1,
  description:
    'A subscription was created or changed status, plan version or covered properties (history keeps every step).',
  payload: z.object({
    subscription_id: z.uuid(),
    plan_version_id: z.uuid(),
    scope: z.enum(['TENANT', 'PROPERTIES']),
    from_status: z.string().nullable(),
    to_status: z.string(),
    reason: z.string().nullable(),
  }),
});

export const EntitlementsChanged = defineEvent({
  type: 'license.entitlements.changed',
  version: 1,
  description:
    "A tenant's (or one property's) effective entitlements may have changed; caches, apps and agent licences re-read them.",
  payload: z.object({
    property_id: z.uuid().nullable(),
    reason: z.enum(['SUBSCRIPTION', 'GRANT', 'LIMIT_OVERRIDE', 'PLAN_VERSION']),
  }),
});

export const LimitReached = defineEvent({
  type: 'license.limit.reached',
  version: 1,
  description:
    'A usage limit was reached for its period: SOFT raises an alert once per period, HARD refuses further use.',
  payload: z.object({
    metric_code: z.string(),
    enforcement: z.enum(['SOFT', 'HARD']),
    period_start: z.iso.datetime().nullable(),
    limit_value: z.number(),
    used: z.number(),
  }),
});
