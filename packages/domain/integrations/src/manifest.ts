import {
  AccessFailed,
  AccessIssued,
  RequisitionSettled,
  AccessRevoked,
  HOTEL_EVENTS,
  PosCheckClosed,
  IntegrationCapabilityChanged,
  IntegrationExceptionOpened,
  IntegrationHealthChanged,
  IntegrationTelemetryReceived,
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
    // Stay-bound access (BUILD_PLAN 13.3): asked through the stay, served by the lock and Wi-Fi connectors.
    { code: 'access.read', descriptionKey: 'integration.permission.access_read', risk: 'READ' },
    {
      code: 'access.key.issue',
      descriptionKey: 'integration.permission.access_key_issue',
      risk: 'HIGH',
    },
    {
      code: 'access.wifi.issue',
      descriptionKey: 'integration.permission.access_wifi_issue',
      risk: 'MEDIUM',
    },
  ],
  // The Integration Platform is the only producer of canonical hotel.* events (Spec §51).
  events: [
    ...HOTEL_EVENTS.map((e) => e.name),
    PosCheckClosed.name,
    IntegrationExceptionOpened.name,
    IntegrationHealthChanged.name,
    IntegrationCapabilityChanged.name,
    IntegrationTelemetryReceived.name,
    AccessIssued.name,
    RequisitionSettled.name,
    AccessRevoked.name,
    AccessFailed.name,
    ReconciliationSnapshotCompleted.name,
    ReconciliationCompleted.name,
  ],
  localeNamespaces: ['integrations'],
});
