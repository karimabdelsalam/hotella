import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  classify,
  translationColumns,
  translationUnique,
  versioned,
} from '@hotella/platform-database';

/**
 * Identity & Access (Spec §5, schema `iam`). Foreign keys to `org.tenants` / `org.properties` are added by hand in
 * the migration (a context never imports another context's schema module; the database still enforces integrity).
 */
export const iam = pgSchema('iam');

export const userStatus = iam.enum('user_status', ['INVITED', 'ACTIVE', 'DISABLED']);
export const membershipStatus = iam.enum('membership_status', ['ACTIVE', 'INACTIVE']);
export const riskLevel = iam.enum('risk_level', ['READ', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A human. Platform staff have no tenant (`tenant_id` null). */
export const persons = classify(
  iam.table(
    'persons',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      givenName: text('given_name').notNull(),
      familyName: text('family_name'),
      email: varchar('email', { length: 320 }),
      phone: varchar('phone', { length: 32 }),
      localePref: varchar('locale_pref', { length: 16 }),
      metadata: jsonb('metadata').notNull().default({}),
      ...versioned(),
    },
    (t) => [index('persons_tenant_idx').on(t.tenantId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    givenName: 'CONFIDENTIAL',
    familyName: 'CONFIDENTIAL',
    email: 'CONFIDENTIAL',
    phone: 'CONFIDENTIAL',
    localePref: 'INTERNAL',
    metadata: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A staff login. Email is stored lower-cased and is unique per tenant (platform staff: unique among platform staff). */
export const users = classify(
  iam.table(
    'users',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      personId: uuid('person_id')
        .notNull()
        .references(() => persons.id, { onDelete: 'restrict' }),
      email: varchar('email', { length: 320 }).notNull(),
      passwordHash: text('password_hash'),
      status: userStatus('status').notNull().default('INVITED'),
      isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
      mfaEnabled: boolean('mfa_enabled').notNull().default(false),
      /** AES-256-GCM ciphertext of the TOTP seed; the key is a SecretRef (IAM_MFA_KEY_REF). Never the plain seed. */
      mfaSecretEnc: text('mfa_secret_enc'),
      /** Last accepted TOTP time step; a code from the same or an older step is rejected (replay protection). */
      mfaLastStep: integer('mfa_last_step'),
      failedLoginCount: integer('failed_login_count').notNull().default(0),
      lockedUntil: tz('locked_until'),
      lastLoginAt: tz('last_login_at'),
      passwordChangedAt: tz('password_changed_at'),
      ...versioned(),
    },
    (t) => [
      unique('users_tenant_email_uq').on(t.tenantId, t.email).nullsNotDistinct(),
      index('users_person_idx').on(t.personId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    personId: 'INTERNAL',
    email: 'CONFIDENTIAL',
    passwordHash: 'RESTRICTED',
    status: 'INTERNAL',
    isPlatformAdmin: 'INTERNAL',
    mfaEnabled: 'INTERNAL',
    mfaSecretEnc: 'RESTRICTED',
    mfaLastStep: 'INTERNAL',
    failedLoginCount: 'INTERNAL',
    lockedUntil: 'INTERNAL',
    lastLoginAt: 'INTERNAL',
    passwordChangedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** One-time invitation to set a password. Only the SHA-256 of the token is stored. */
export const userInvitations = classify(
  iam.table(
    'user_invitations',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      tokenHash: varchar('token_hash', { length: 64 })
        .notNull()
        .unique('user_invitations_token_uq'),
      expiresAt: tz('expires_at').notNull(),
      acceptedAt: tz('accepted_at'),
      createdBy: uuid('created_by'),
    },
    (t) => [index('user_invitations_user_idx').on(t.userId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    userId: 'INTERNAL',
    tokenHash: 'RESTRICTED',
    expiresAt: 'INTERNAL',
    acceptedAt: 'INTERNAL',
    createdBy: 'INTERNAL',
  },
);

/** Platform catalog of permissions, synced from module manifests at boot (not tenant-owned). */
export const permissions = classify(
  iam.table('permissions', {
    code: varchar('code', { length: 128 }).primaryKey(),
    module: varchar('module', { length: 32 }).notNull(),
    risk: riskLevel('risk').notNull(),
    descriptionKey: varchar('description_key', { length: 128 }).notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  }),
  {
    code: 'PUBLIC',
    module: 'PUBLIC',
    risk: 'PUBLIC',
    descriptionKey: 'PUBLIC',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/** System roles have `tenant_id` null and `is_system` true; tenants may define their own roles. */
export const roles = classify(
  iam.table(
    'roles',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      code: varchar('code', { length: 64 }).notNull(),
      isSystem: boolean('is_system').notNull().default(false),
      ...versioned(),
    },
    (t) => [unique('roles_tenant_code_uq').on(t.tenantId, t.code).nullsNotDistinct()],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    code: 'INTERNAL',
    isSystem: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const roleTranslations = classify(
  iam.table(
    'role_translations',
    {
      ...translationColumns(() => roles.id),
      name: text('name').notNull(),
      description: text('description'),
    },
    (t) => [translationUnique('role_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'INTERNAL',
    description: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

export const rolePermissions = classify(
  iam.table(
    'role_permissions',
    {
      roleId: uuid('role_id')
        .notNull()
        .references(() => roles.id, { onDelete: 'cascade' }),
      permissionCode: varchar('permission_code', { length: 128 })
        .notNull()
        .references(() => permissions.code, { onDelete: 'cascade' }),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionCode] })],
  ),
  { roleId: 'INTERNAL', permissionCode: 'INTERNAL', createdAt: 'INTERNAL' },
);

/**
 * Where a user works and with which roles. Scope: tenant-wide (organization and property null), one organization
 * (its properties), or one property.
 */
export const memberships = classify(
  iam.table(
    'memberships',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      organizationId: uuid('organization_id'),
      propertyId: uuid('property_id'),
      status: membershipStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [
      unique('memberships_scope_uq')
        .on(t.userId, t.tenantId, t.organizationId, t.propertyId)
        .nullsNotDistinct(),
      index('memberships_user_idx').on(t.userId, t.status),
      index('memberships_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    userId: 'INTERNAL',
    organizationId: 'INTERNAL',
    propertyId: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const membershipRoles = classify(
  iam.table(
    'membership_roles',
    {
      membershipId: uuid('membership_id')
        .notNull()
        .references(() => memberships.id, { onDelete: 'cascade' }),
      roleId: uuid('role_id')
        .notNull()
        .references(() => roles.id, { onDelete: 'restrict' }),
      grantedAt: tz('granted_at').notNull().defaultNow(),
      grantedBy: uuid('granted_by'),
    },
    (t) => [
      primaryKey({ name: 'membership_roles_pk', columns: [t.membershipId, t.roleId] }),
      index('membership_roles_role_idx').on(t.roleId),
    ],
  ),
  { membershipId: 'INTERNAL', roleId: 'INTERNAL', grantedAt: 'INTERNAL', grantedBy: 'INTERNAL' },
);

/** A login session (a refresh-token family). Revoking it ends every token in the chain. */
export const sessions = classify(
  iam.table(
    'sessions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      ip: varchar('ip', { length: 64 }),
      userAgent: text('user_agent'),
      mfaVerified: boolean('mfa_verified').notNull().default(false),
      expiresAt: tz('expires_at').notNull(),
      lastUsedAt: tz('last_used_at'),
      revokedAt: tz('revoked_at'),
      revokeReason: varchar('revoke_reason', { length: 32 }),
    },
    (t) => [index('sessions_user_idx').on(t.userId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    userId: 'INTERNAL',
    ip: 'CONFIDENTIAL',
    userAgent: 'INTERNAL',
    mfaVerified: 'INTERNAL',
    expiresAt: 'INTERNAL',
    lastUsedAt: 'INTERNAL',
    revokedAt: 'INTERNAL',
    revokeReason: 'INTERNAL',
  },
);

/** Every refresh token ever issued for a session; presenting a used one revokes the session (reuse detection). */
export const refreshTokens = classify(
  iam.table(
    'refresh_tokens',
    {
      id: uuid('id').primaryKey(),
      sessionId: uuid('session_id')
        .notNull()
        .references(() => sessions.id, { onDelete: 'cascade' }),
      tokenHash: varchar('token_hash', { length: 64 }).notNull().unique('refresh_tokens_hash_uq'),
      issuedAt: tz('issued_at').notNull().defaultNow(),
      expiresAt: tz('expires_at').notNull(),
      usedAt: tz('used_at'),
      replacedById: uuid('replaced_by_id'),
    },
    (t) => [
      index('refresh_tokens_session_idx').on(t.sessionId),
      foreignKey({
        name: 'refresh_tokens_replaced_by_fk',
        columns: [t.replacedById],
        foreignColumns: [t.id],
      }).onDelete('set null'),
    ],
  ),
  {
    id: 'INTERNAL',
    sessionId: 'INTERNAL',
    tokenHash: 'RESTRICTED',
    issuedAt: 'INTERNAL',
    expiresAt: 'INTERNAL',
    usedAt: 'INTERNAL',
    replacedById: 'INTERNAL',
  },
);

/** Spec §64 — explicit, scoped, time-limited, read-only by default, reason-based, revocable support access. */
export const supportAccessGrants = classify(
  iam.table(
    'support_access_grants',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      grantedToUserId: uuid('granted_to_user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      requestedBy: uuid('requested_by').notNull(),
      reason: text('reason').notNull(),
      scopes: text('scopes').array().notNull(),
      readOnly: boolean('read_only').notNull().default(true),
      startsAt: tz('starts_at').notNull(),
      expiresAt: tz('expires_at').notNull(),
      approvedBy: uuid('approved_by'),
      approvedAt: tz('approved_at'),
      revokedAt: tz('revoked_at'),
      revokedBy: uuid('revoked_by'),
      ...versioned(),
    },
    (t) => [index('support_access_grants_tenant_idx').on(t.tenantId, t.grantedToUserId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    grantedToUserId: 'INTERNAL',
    requestedBy: 'INTERNAL',
    reason: 'CONFIDENTIAL',
    scopes: 'INTERNAL',
    readOnly: 'INTERNAL',
    startsAt: 'INTERNAL',
    expiresAt: 'INTERNAL',
    approvedBy: 'INTERNAL',
    approvedAt: 'INTERNAL',
    revokedAt: 'INTERNAL',
    revokedBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type PersonRow = typeof persons.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type PermissionRow = typeof permissions.$inferSelect;
export type SupportAccessGrantRow = typeof supportAccessGrants.$inferSelect;
