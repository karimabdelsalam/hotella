import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';

/** Settings owned by the organization context (Spec §72); registered by OrganizationModule. */
export const ORG_CHECKOUT_TIME = defineSetting({
  key: 'org.property.checkout_time',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  default: '12:00',
  descriptionKey: 'org.setting.checkout_time',
});

export const ORGANIZATION_SETTINGS = [ORG_CHECKOUT_TIME];
