/**
 * The system role catalog (tenant_id null, immutable for tenants). Names and descriptions live in the locale
 * catalog under `iam.role.<code>.name|description`; permissions are synced at boot. Later phases extend these
 * lists in the sprint that introduces each permission (and update this file's test).
 */
export interface SystemRoleDefinition {
  readonly code: string;
  /** Platform staff roles are granted to users without a tenant; tenant roles through memberships. */
  readonly audience: 'PLATFORM' | 'TENANT';
  readonly permissions: readonly string[];
}

const PROPERTY_READ = ['org.property.read', 'branding.read'] as const;
/** Guest-facing desks: see stays and guests, keep preferences/consents (Spec §6, §26). */
const GUEST_DESK = ['guest.read', 'guest.manage', 'stay.read'] as const;
/** Everyone who does operational work: see, take, start, pause and finish their tasks (Spec §8.2). */
const TASK_WORKER = ['task.read', 'task.accept', 'task.complete'] as const;
/** Supervisors also dispatch work and may act for an assignee. */
const TASK_SUPERVISOR = [...TASK_WORKER, 'task.assign', 'task.cancel'] as const;
/** Who watches the alert board (Spec §15) and acts on it. */
const ALERT_DESK = ['alert.read', 'alert.ack'] as const;

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  {
    code: 'PLATFORM_ADMIN',
    audience: 'PLATFORM',
    // Spec §63–§64: manages tenants and their structure, never guest or operational data.
    permissions: [
      'org.tenant.manage',
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'branding.read',
      'branding.manage',
      'iam.user.read',
      'iam.user.manage',
      'iam.role.manage',
      'iam.membership.manage',
      'support.access.request',
      'config.read',
      'config.manage',
      // Integration onboarding (Spec §63, ADR-0017): instances, mappings, replays — never raw guest payloads.
      'integration.read',
      'integration.configure',
      'integration.mapping.confirm',
      'integration.replay',
      'integration.reconcile',
    ],
  },
  { code: 'SUPPORT', audience: 'PLATFORM', permissions: ['support.access.request'] },
  {
    code: 'GENERAL_MANAGER',
    audience: 'TENANT',
    permissions: [
      ...PROPERTY_READ,
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'branding.manage',
      'iam.user.read',
      'iam.user.manage',
      'iam.role.manage',
      'iam.membership.manage',
      'support.access.approve',
      'audit.read',
      'config.read',
      'config.manage',
      'integration.read',
      'integration.mapping.confirm',
      'integration.replay',
      'integration.reconcile',
      ...GUEST_DESK,
      'guest.merge',
      'guest.data_request.manage',
      'stay.manage',
      ...TASK_SUPERVISOR,
      'sla.manage',
      ...ALERT_DESK,
      'workflow.manage',
      'approval.read',
      'approval.decide',
    ],
  },
  {
    code: 'DUTY_MANAGER',
    audience: 'TENANT',
    permissions: [
      ...PROPERTY_READ,
      'iam.user.read',
      'integration.read',
      ...GUEST_DESK,
      ...TASK_SUPERVISOR,
      ...ALERT_DESK,
      'approval.read',
      'approval.decide',
    ],
  },
  {
    code: 'HK_SUPERVISOR',
    audience: 'TENANT',
    permissions: [...PROPERTY_READ, 'iam.user.read', ...TASK_SUPERVISOR, ...ALERT_DESK],
  },
  {
    code: 'ROOM_ATTENDANT',
    audience: 'TENANT',
    permissions: ['org.property.read', ...TASK_WORKER],
  },
  { code: 'ENGINEER', audience: 'TENANT', permissions: ['org.property.read', ...TASK_WORKER] },
  {
    code: 'FRONT_DESK',
    audience: 'TENANT',
    permissions: [...PROPERTY_READ, ...GUEST_DESK, ...TASK_WORKER],
  },
  {
    code: 'GUEST_RELATIONS',
    audience: 'TENANT',
    permissions: [...PROPERTY_READ, ...GUEST_DESK, ...TASK_WORKER],
  },
];

export const PLATFORM_ADMIN_ROLE = 'PLATFORM_ADMIN';
export const SUPPORT_ROLE = 'SUPPORT';

/** Locale keys for a role code (`GENERAL_MANAGER` → `iam.role.general_manager.name`). */
export function roleNameKey(code: string): string {
  return `iam.role.${code.toLowerCase()}.name`;
}
export function roleDescriptionKey(code: string): string {
  return `iam.role.${code.toLowerCase()}.description`;
}
