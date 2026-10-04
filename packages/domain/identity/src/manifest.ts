import {
  MembershipChanged,
  RolePermissionsChanged,
  SessionRevoked,
  UserCreated,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const IDENTITY_MANIFEST = defineManifest({
  code: 'iam',
  schema: 'iam',
  description:
    'Identity & Access: staff users, memberships, roles and permissions, sessions, MFA, support-access grants.',
  permissions: [
    { code: 'iam.user.read', descriptionKey: 'iam.permission.user_read', risk: 'READ' },
    { code: 'iam.user.manage', descriptionKey: 'iam.permission.user_manage', risk: 'HIGH' },
    {
      code: 'iam.api_client.manage',
      descriptionKey: 'iam.permission.api_client_manage',
      risk: 'HIGH',
    },
    { code: 'iam.role.manage', descriptionKey: 'iam.permission.role_manage', risk: 'HIGH' },
    {
      code: 'iam.membership.manage',
      descriptionKey: 'iam.permission.membership_manage',
      risk: 'HIGH',
    },
    {
      code: 'support.access.request',
      descriptionKey: 'iam.permission.support_access_request',
      risk: 'MEDIUM',
    },
    {
      code: 'support.access.approve',
      descriptionKey: 'iam.permission.support_access_approve',
      risk: 'HIGH',
    },
  ],
  events: [
    UserCreated.name,
    MembershipChanged.name,
    RolePermissionsChanged.name,
    SessionRevoked.name,
  ],
  localeNamespaces: ['identity'],
});
