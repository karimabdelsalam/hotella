import { z } from 'zod';
import { defineEvent } from './registry';

/** Identity & Access events (Spec §5). Payloads never carry credentials, hashes or contact details beyond ids. */

export const UserCreated = defineEvent({
  type: 'iam.user.created',
  version: 1,
  description: 'A staff user account was created (invited or bootstrapped).',
  payload: z.object({
    user_id: z.uuid(),
    tenant_id: z.uuid().nullable(),
    status: z.enum(['INVITED', 'ACTIVE']),
    is_platform_admin: z.boolean(),
  }),
});

export const MembershipChanged = defineEvent({
  type: 'iam.membership.changed',
  version: 1,
  description:
    'A membership was granted, re-scoped, had its roles changed or was deactivated; consumers recompute access.',
  payload: z.object({
    membership_id: z.uuid(),
    user_id: z.uuid(),
    tenant_id: z.uuid(),
    property_id: z.uuid().nullable(),
    status: z.enum(['ACTIVE', 'INACTIVE']),
    role_codes: z.array(z.string()),
  }),
});

export const RolePermissionsChanged = defineEvent({
  type: 'iam.role_permissions.changed',
  version: 1,
  description: 'The permission set of a role changed.',
  payload: z.object({
    role_id: z.uuid(),
    tenant_id: z.uuid().nullable(),
    code: z.string(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  }),
});

export const SessionRevoked = defineEvent({
  type: 'iam.session.revoked',
  version: 1,
  description:
    'A staff session was revoked (logout, refresh-token reuse, lockout, user disabled). Realtime connections for it must close.',
  payload: z.object({
    session_id: z.uuid(),
    user_id: z.uuid(),
    reason: z.enum(['LOGOUT', 'TOKEN_REUSE', 'USER_DISABLED', 'PASSWORD_CHANGED', 'ADMIN']),
  }),
});
