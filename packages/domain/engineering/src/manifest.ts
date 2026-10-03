import { WorkOrderClosed, WorkOrderCreated } from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const ENGINEERING_MANIFEST = defineManifest({
  code: 'eng',
  schema: 'eng',
  description:
    'Engineering / CMMS: asset registry (types with controlled properties, models, hierarchy, locations), asset documents linked to knowledge, failure taxonomy; work orders, meters, preventive maintenance, parts, warranty and room restrictions follow in Phase 8.',
  permissions: [
    { code: 'eng.asset.read', descriptionKey: 'eng.permission.asset_read', risk: 'READ' },
    { code: 'eng.asset.manage', descriptionKey: 'eng.permission.asset_manage', risk: 'LOW' },
    { code: 'eng.config.manage', descriptionKey: 'eng.permission.config_manage', risk: 'MEDIUM' },
    { code: 'eng.work_order.read', descriptionKey: 'eng.permission.work_order_read', risk: 'READ' },
    {
      code: 'eng.work_order.manage',
      descriptionKey: 'eng.permission.work_order_manage',
      risk: 'LOW',
    },
    { code: 'eng.parts.manage', descriptionKey: 'eng.permission.parts_manage', risk: 'LOW' },
  ],
  events: [WorkOrderCreated.name, WorkOrderClosed.name],
  entitlements: ['ENGINEERING'],
  localeNamespaces: ['eng'],
});
