import { HandoverAcknowledged } from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const LOGBOOK_MANIFEST = defineManifest({
  code: 'logbook',
  schema: 'logbook',
  description:
    'Logbook: append-only shift entries per department (notes, incidents, handover items) and the shift handover — facts counted by code, a draft by the SHIFT_HANDOVER assistant, acknowledged by the incoming supervisor.',
  permissions: [
    { code: 'logbook.read', descriptionKey: 'logbook.permission.read', risk: 'READ' },
    { code: 'logbook.write', descriptionKey: 'logbook.permission.write', risk: 'LOW' },
    {
      code: 'logbook.handover.acknowledge',
      descriptionKey: 'logbook.permission.handover_acknowledge',
      risk: 'LOW',
    },
  ],
  events: [HandoverAcknowledged.name],
  aiTools: [{ code: 'logbook.get_shift_facts', risk: 'READ', requiredPermission: 'logbook.read' }],
  entitlements: ['LOGBOOK'],
  entitlement: 'LOGBOOK',
  localeNamespaces: ['logbook'],
});
