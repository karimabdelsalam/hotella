import { z } from 'zod';
import { defineEvent } from './registry';

export const TenantCreated = defineEvent({
  type: 'org.tenant.created',
  version: 1,
  description: 'A SaaS tenant (hotel company or group) was created.',
  payload: z.object({
    tenant_id: z.uuid(),
    code: z.string(),
    name: z.string(),
    default_locale: z.string(),
  }),
});

export const PropertyCreated = defineEvent({
  type: 'org.property.created',
  version: 1,
  description: 'A property (hotel) was created under a tenant/organization.',
  payload: z.object({
    property_id: z.uuid(),
    tenant_id: z.uuid(),
    organization_id: z.uuid().nullable(),
    code: z.string(),
    name: z.string(),
    timezone: z.string(),
    currency: z.string(),
    default_locale: z.string(),
  }),
});

export const PropertyUpdated = defineEvent({
  type: 'org.property.updated',
  version: 1,
  description: 'Property attributes changed (name, status, locales, timezone, settings).',
  payload: z.object({ property_id: z.uuid(), changed: z.array(z.string()) }),
});

export const LocationCreated = defineEvent({
  type: 'org.location.created',
  version: 1,
  description: 'A node was added to a property location tree (building, floor, room, area, plant).',
  payload: z.object({
    location_id: z.uuid(),
    property_id: z.uuid(),
    parent_id: z.uuid().nullable(),
    kind: z.string(),
    code: z.string(),
    path: z.string(),
  }),
});

export const RoomCreated = defineEvent({
  type: 'org.room.created',
  version: 1,
  description: 'A room (location specialization) was created.',
  payload: z.object({
    room_id: z.uuid(),
    property_id: z.uuid(),
    room_number: z.string(),
    room_type_id: z.uuid().nullable(),
  }),
});

export const BrandProfileUpdated = defineEvent({
  type: 'org.brand_profile.updated',
  version: 1,
  description: 'A tenant/organization/property/channel brand profile was created or changed.',
  payload: z.object({
    brand_profile_id: z.uuid(),
    tenant_id: z.uuid(),
    scope: z.enum(['TENANT', 'ORGANIZATION', 'PROPERTY', 'CHANNEL']),
    scope_id: z.uuid(),
    channel: z.string().nullable(),
  }),
});
