import {
  ServiceRequestCreated,
  ServiceRequestRelated,
  ServiceRequestStatusChanged,
  ServiceVersionPublished,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const CATALOG_MANIFEST = defineManifest({
  code: 'catalog',
  schema: 'catalog',
  description:
    'Guest service catalog: categories, versioned services with translations, eligibility and availability, and service requests bound to the operations engine.',
  permissions: [
    { code: 'catalog.read', descriptionKey: 'catalog.permission.read', risk: 'READ' },
    { code: 'catalog.manage', descriptionKey: 'catalog.permission.manage', risk: 'MEDIUM' },
    { code: 'catalog.publish', descriptionKey: 'catalog.permission.publish', risk: 'MEDIUM' },
    { code: 'request.read', descriptionKey: 'catalog.permission.request_read', risk: 'READ' },
    { code: 'request.create', descriptionKey: 'catalog.permission.request_create', risk: 'LOW' },
    { code: 'request.manage', descriptionKey: 'catalog.permission.request_manage', risk: 'LOW' },
  ],
  events: [
    ServiceVersionPublished.name,
    ServiceRequestCreated.name,
    ServiceRequestStatusChanged.name,
    ServiceRequestRelated.name,
  ],
  entitlements: ['GUEST_EXPERIENCE'],
  entitlement: 'GUEST_EXPERIENCE',
  localeNamespaces: ['catalog'],
});
