import { z } from 'zod';

export const SCHEMA_NAMES = [
  'platform',
  'org',
  'iam',
  'guest',
  'catalog',
  'ops',
  'hk',
  'eng',
  'inspection',
  'relations',
  'lostfound',
  'logbook',
  'comms',
  'knowledge',
  'ai',
  'integration',
  'license',
  'audit',
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

/** `<domain>.<resource>.<action>` or `<resource>.<action>` (Spec §5, CLAUDE.md rule 24). */
export const PERMISSION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;
export const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export const permissionSchema = z.object({
  code: z.string().regex(PERMISSION_RE),
  /** Locale key for the human description, e.g. `iam.permission.task_assign`. */
  descriptionKey: z.string().min(1),
  risk: z.enum(['READ', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('LOW'),
});

export const aiToolSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  risk: z.enum(['READ', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  requiredPermission: z.string().regex(PERMISSION_RE),
});

/** Spec §76. One per bounded context; validated and registered at boot. */
export const moduleManifestSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  schema: z.enum(SCHEMA_NAMES),
  description: z.string().min(1),
  permissions: z.array(permissionSchema).default([]),
  /** Full event names this module publishes (`<ctx>.<entity>.<event>.vN`). */
  events: z.array(z.string()).default([]),
  /** Entitlement capability codes the module checks (Spec §58–§60), e.g. `HOUSEKEEPING`, `AI_GUEST`. */
  entitlements: z.array(z.string().regex(CODE_RE)).default([]),
  /**
   * The entitlement every permission of this module requires at the action gate (Spec §60), e.g. `HOUSEKEEPING`.
   * Absent: the module is part of `CORE`. Must also be listed in `entitlements`.
   */
  entitlement: z.string().regex(CODE_RE).optional(),
  aiTools: z.array(aiToolSchema).default([]),
  /** Files under /locales/<locale>/ this module owns, e.g. `housekeeping`. */
  localeNamespaces: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).default([]),
  /** Connector capabilities consumed (Spec §46), e.g. `ROOM_STATUS_READ`. */
  integrationCapabilities: z.array(z.string().regex(CODE_RE)).default([]),
});
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;
export type ModuleManifestInput = z.input<typeof moduleManifestSchema>;

/** Validates at definition time so a malformed manifest fails the build/test, not production boot. */
export function defineManifest(input: ModuleManifestInput): ModuleManifest {
  return moduleManifestSchema.parse(input);
}
