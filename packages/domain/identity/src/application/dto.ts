import { z } from 'zod';
import { localeSchema, uuidSchema } from '@hotella/contracts-api';
import { PASSWORD_MAX_LENGTH } from '../domain/passwords';

const email = z
  .email()
  .max(320)
  .transform((e) => e.trim().toLowerCase());
/** The policy (length, no email) is checked in the service so the error can be localized precisely. */
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const roleCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Role code: A–Z 0–9 _');

export const loginSchema = z.object({
  /** Tenant code for hotel staff; omitted by platform staff. */
  tenantCode: z.string().trim().min(2).max(32).optional(),
  email,
  password,
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  challengeToken: z.string().min(10).max(4096),
  code: z.string().regex(/^\d{6}$/),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const mfaActivateSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const refreshSchema = z.object({ refreshToken: z.string().min(10).max(256) });

export const acceptInvitationSchema = z.object({
  token: z.string().min(10).max(256),
  password,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

const membershipGrant = z.object({
  /** Omit for a tenant-wide membership. */
  propertyId: uuidSchema.nullish(),
  roleCodes: z.array(roleCode).min(1).max(20),
});
export type MembershipGrantInput = z.infer<typeof membershipGrant>;

export const createUserSchema = z.object({
  email,
  givenName: z.string().trim().min(1).max(100),
  familyName: z.string().trim().max(100).nullish(),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, 'E.164 phone, e.g. +201001234567')
    .nullish(),
  localePref: localeSchema.nullish(),
  memberships: z.array(membershipGrant).max(50).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserStatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });

export const grantMembershipSchema = membershipGrant;
export const replaceMembershipRolesSchema = z.object({
  roleCodes: z.array(roleCode).min(1).max(20),
});

const permissionCode = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/);
export const createRoleSchema = z.object({
  code: roleCode,
  translations: z
    .array(
      z.object({
        locale: localeSchema,
        name: z.string().trim().min(1).max(100),
        description: z.string().trim().max(500).nullish(),
      }),
    )
    .min(1),
  permissions: z.array(permissionCode).min(1).max(500),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const replaceRolePermissionsSchema = z.object({
  permissions: z.array(permissionCode).min(1).max(500),
});
