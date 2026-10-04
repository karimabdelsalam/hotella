import {
  HOTEL_EVENTS,
  IntegrationCapabilityChanged,
  IntegrationExceptionOpened,
  IntegrationHealthChanged,
  ReconciliationCompleted,
  ReconciliationSnapshotCompleted,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const INTEGRATIONS_MANIFEST = defineManifest({
  code: 'integration',
  schema: 'integration',
  description:
    'Integration Platform: connector catalog, integration instances, raw message inbox, parser/mapper to canonical hotel.* events, mappings, exceptions, external references, commands, health.',
  permissions: [
    {
      code: 'integration.read',
      descriptionKey: 'integration.permission.read',
      risk: 'READ',
    },
    {
      code: 'integration.configure',
      descriptionKey: 'integration.permission.configure',
      risk: 'HIGH',
    },
    {
      code: 'integration.replay',
      descriptionKey: 'integration.permission.replay',
      risk: 'MEDIUM',
    },
    {
      code: 'integration.mapping.confirm',
      descriptionKey: 'integration.permission.mapping_confirm',
      risk: 'MEDIUM',
    },
    {
      code: 'integration.reconcile',
      descriptionKey: 'integration.permission.reconcile',
      risk: 'LOW',
    },
    {
      code: 'integration.capability.manage',
      descriptionKey: 'integration.permission.capability_manage',
      risk: 'HIGH',
    },
    {
      code: 'integration.capability.verify',
      descriptionKey: 'integration.permission.capability_verify',
      risk: 'HIGH',
    },
    {
      code: 'integration.webhook.manage',
      descriptionKey: 'integration.permission.webhook_manage',
      risk: 'HIGH',
    },
  ],
  // The Integration Platform is the only producer of canonical hotel.* events (Spec §51).
  events: [
    ...HOTEL_EVENTS.map((e) => e.name),
    IntegrationExceptionOpened.name,
    IntegrationHealthChanged.name,
    IntegrationCapabilityChanged.name,
    ReconciliationSnapshotCompleted.name,
    ReconciliationCompleted.name,
  ],
  localeNamespaces: ['integrations'],
});
