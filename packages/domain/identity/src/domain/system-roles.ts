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
      'branding.read',
      'branding.manage',
      'iam.user.read',
      'iam.user.manage',
      'iam.role.manage',
      'iam.membership.manage',
      'support.access.request',
      'config.read',
      'config.manage',
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
      'branding.manage',
      'iam.user.read',
      'iam.user.manage',
      'iam.role.manage',
      'iam.membership.manage',
      'support.access.approve',
      'audit.read',
      'config.read',
      'config.manage',
    ],
  },
  { code: 'DUTY_MANAGER', audience: 'TENANT', permissions: [...PROPERTY_READ, 'iam.user.read'] },
  { code: 'HK_SUPERVISOR', audience: 'TENANT', permissions: [...PROPERTY_READ, 'iam.user.read'] },
  { code: 'ROOM_ATTENDANT', audience: 'TENANT', permissions: ['org.property.read'] },
  { code: 'ENGINEER', audience: 'TENANT', permissions: ['org.property.read'] },
  { code: 'FRONT_DESK', audience: 'TENANT', permissions: [...PROPERTY_READ] },
  { code: 'GUEST_RELATIONS', audience: 'TENANT', permissions: [...PROPERTY_READ] },
];

export const PLATFORM_ADMIN_ROLE = 'PLATFORM_ADMIN';

/** Locale keys for a role code (`GENERAL_MANAGER` → `iam.role.general_manager.name`). */
export function roleNameKey(code: string): string {
  return `iam.role.${code.toLowerCase()}.name`;
}
export function roleDescriptionKey(code: string): string {
  return `iam.role.${code.toLowerCase()}.description`;
}
