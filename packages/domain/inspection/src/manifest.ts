import { InspectionCompleted, InspectionFindingRaised } from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const INSPECTION_MANIFEST = defineManifest({
  code: 'inspection',
  schema: 'inspection',
  description:
    'Generic inspection engine: versioned checklists for rooms, areas and equipment, inspections with photos, deterministic scoring and findings, critical findings opening urgent work.',
  permissions: [
    {
      code: 'inspection.template.manage',
      descriptionKey: 'inspection.permission.template_manage',
      risk: 'MEDIUM',
    },
    { code: 'inspection.perform', descriptionKey: 'inspection.permission.perform', risk: 'LOW' },
    { code: 'inspection.read', descriptionKey: 'inspection.permission.read', risk: 'READ' },
  ],
  events: [InspectionCompleted.name, InspectionFindingRaised.name],
  entitlements: ['INSPECTIONS'],
  localeNamespaces: ['inspection'],
});
