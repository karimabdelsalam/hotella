import {
  HkJobCreated,
  HkJobStatusChanged,
  RoomReady,
  RoomSignalChanged,
  RoomStateChanged,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const HOUSEKEEPING_MANIFEST = defineManifest({
  code: 'hk',
  schema: 'hk',
  description:
    'Housekeeping: room operational state (occupancy, housekeeping, front office) with history, service and privacy signals, cleaning jobs with credits, inspections and room readiness.',
  permissions: [
    { code: 'hk.board.read', descriptionKey: 'hk.permission.board_read', risk: 'READ' },
    { code: 'hk.room.manage', descriptionKey: 'hk.permission.room_manage', risk: 'LOW' },
    { code: 'hk.job.manage', descriptionKey: 'hk.permission.job_manage', risk: 'LOW' },
    { code: 'hk.inspect', descriptionKey: 'hk.permission.inspect', risk: 'LOW' },
    { code: 'hk.config.manage', descriptionKey: 'hk.permission.config_manage', risk: 'MEDIUM' },
  ],
  events: [
    RoomStateChanged.name,
    RoomSignalChanged.name,
    HkJobCreated.name,
    HkJobStatusChanged.name,
    RoomReady.name,
  ],
  aiTools: [
    { code: 'housekeeping.set_room_signal', risk: 'LOW', requiredPermission: 'hk.room.manage' },
  ],
  entitlements: ['HOUSEKEEPING'],
  localeNamespaces: ['hk'],
  integrationCapabilities: ['ROOM_STATUS_READ', 'ROOM_STATUS_WRITE'],
});
