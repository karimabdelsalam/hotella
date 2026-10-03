import { ComplaintOpened, ComplaintResolved } from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const RELATIONS_MANIFEST = defineManifest({
  code: 'relations',
  schema: 'relations',
  description:
    'Guest relations: complaints with categories, links and evidence, complaint candidates suggested by the concierge and confirmed by a person, and service recovery with approvals for anything that costs money.',
  permissions: [
    { code: 'complaint.read', descriptionKey: 'relations.permission.read', risk: 'READ' },
    { code: 'complaint.manage', descriptionKey: 'relations.permission.manage', risk: 'LOW' },
    {
      code: 'complaint.category.manage',
      descriptionKey: 'relations.permission.category_manage',
      risk: 'MEDIUM',
    },
    {
      code: 'complaint.recovery.manage',
      descriptionKey: 'relations.permission.recovery_manage',
      risk: 'MEDIUM',
    },
    { code: 'complaint.suggest', descriptionKey: 'relations.permission.suggest', risk: 'LOW' },
  ],
  events: [ComplaintOpened.name, ComplaintResolved.name],
  aiTools: [
    { code: 'relations.suggest_complaint', risk: 'LOW', requiredPermission: 'complaint.suggest' },
  ],
  entitlements: ['GUEST_RELATIONS'],
  localeNamespaces: ['relations'],
});
