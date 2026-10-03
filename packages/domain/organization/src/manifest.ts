import {
  BrandProfileUpdated,
  LocationCreated,
  PropertyCreated,
  PropertyUpdated,
  RoomCreated,
  TenantCreated,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const ORGANIZATION_MANIFEST = defineManifest({
  code: 'org',
  schema: 'org',
  description:
    'Organization & Property: tenants, organizations, properties, location tree, rooms, brand profiles.',
  permissions: [
    { code: 'org.tenant.manage', descriptionKey: 'org.permission.tenant_manage', risk: 'CRITICAL' },
    { code: 'org.property.read', descriptionKey: 'org.permission.property_read', risk: 'READ' },
    { code: 'org.property.manage', descriptionKey: 'org.permission.property_manage', risk: 'HIGH' },
    {
      code: 'org.location.manage',
      descriptionKey: 'org.permission.location_manage',
      risk: 'MEDIUM',
    },
    { code: 'branding.read', descriptionKey: 'org.permission.branding_read', risk: 'READ' },
    { code: 'branding.manage', descriptionKey: 'org.permission.branding_manage', risk: 'MEDIUM' },
  ],
  events: [
    TenantCreated.name,
    PropertyCreated.name,
    PropertyUpdated.name,
    LocationCreated.name,
    RoomCreated.name,
    BrandProfileUpdated.name,
  ],
  localeNamespaces: ['organization'],
});
