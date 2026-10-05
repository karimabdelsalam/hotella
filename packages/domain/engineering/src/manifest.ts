import {
  MeterReadingRecorded,
  PmDue,
  RoomRestrictionChanged,
  TelemetryAlarmCleared,
  TelemetryAlarmRaised,
  WorkOrderClosed,
  WorkOrderCreated,
} from '@hotella/contracts-events';
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
    { code: 'eng.pm.manage', descriptionKey: 'eng.permission.pm_manage', risk: 'LOW' },
    {
      code: 'eng.restriction.manage',
      descriptionKey: 'eng.permission.restriction_manage',
      risk: 'MEDIUM',
    },
    { code: 'eng.telemetry.read', descriptionKey: 'eng.permission.telemetry_read', risk: 'READ' },
    {
      code: 'eng.telemetry.manage',
      descriptionKey: 'eng.permission.telemetry_manage',
      risk: 'MEDIUM',
    },
    {
      code: 'eng.telemetry.acknowledge',
      descriptionKey: 'eng.permission.telemetry_acknowledge',
      risk: 'LOW',
    },
  ],
  events: [
    WorkOrderCreated.name,
    WorkOrderClosed.name,
    MeterReadingRecorded.name,
    PmDue.name,
    RoomRestrictionChanged.name,
    TelemetryAlarmRaised.name,
    TelemetryAlarmCleared.name,
  ],
  // The Engineering Copilot's tools (BUILD_PLAN 8.4): all READ.
  aiTools: [
    { code: 'engineering.find_assets', risk: 'READ', requiredPermission: 'eng.asset.read' },
    {
      code: 'engineering.get_asset_history',
      risk: 'READ',
      requiredPermission: 'eng.work_order.read',
    },
    {
      code: 'engineering.likely_failure_modes',
      risk: 'READ',
      requiredPermission: 'eng.work_order.read',
    },
    { code: 'engineering.search_manuals', risk: 'READ', requiredPermission: 'eng.asset.read' },
  ],
  integrationCapabilities: ['OOO_WRITE', 'TELEMETRY_READ'],
  entitlements: ['ENGINEERING'],
  entitlement: 'ENGINEERING',
  localeNamespaces: ['eng'],
});
