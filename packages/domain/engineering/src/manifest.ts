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
  ],
  events: [],
  entitlements: ['ENGINEERING'],
  localeNamespaces: ['eng'],
});
