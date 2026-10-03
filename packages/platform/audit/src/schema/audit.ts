import { index, jsonb, pgSchema, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { classify, newId } from '@hotella/platform-database';

/**
 * Spec §68 audit trail. Append-only: the migration installs triggers that reject UPDATE, DELETE and TRUNCATE for every
 * role, so a bug or a compromised application account cannot rewrite history. Retention purges (Spec §69) will run
 * as a dedicated maintenance role that is allowed to disable the trigger, recorded in its own audit entry.
 */
export const audit = pgSchema('audit');

export const actorTypeEnum = audit.enum('actor_type', [
  'USER',
  'GUEST',
  'AI_AGENT',
  'SYSTEM',
  'INTEGRATION',
  'SUPPORT',
]);

export const auditLog = classify(
  audit.table(
    'audit_log',
    {
      id: uuid('id').primaryKey().$defaultFn(newId),
      occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
      tenantId: uuid('tenant_id'),
      propertyId: uuid('property_id'),
      actorType: actorTypeEnum('actor_type').notNull(),
      actorId: varchar('actor_id', { length: 64 }),
      /** What happened, named like a permission/event: `org.property.update`, `iam.session.revoke`. */
      action: varchar('action', { length: 128 }).notNull(),
      entityType: varchar('entity_type', { length: 64 }).notNull(),
      entityId: varchar('entity_id', { length: 128 }).notNull(),
      /** Redacted snapshots: SENSITIVE/RESTRICTED columns never reach the audit log. */
      before: jsonb('before'),
      after: jsonb('after'),
      reason: text('reason'),
      approvalRef: varchar('approval_ref', { length: 128 }),
      policyRef: varchar('policy_ref', { length: 128 }),
      correlationId: varchar('correlation_id', { length: 128 }),
      traceId: varchar('trace_id', { length: 32 }),
    },
    (t) => [
      index('audit_log_entity_idx').on(t.tenantId, t.entityType, t.entityId, t.occurredAt),
      index('audit_log_tenant_time_idx').on(t.tenantId, t.occurredAt),
      index('audit_log_correlation_idx').on(t.correlationId),
    ],
  ),
  {
    id: 'INTERNAL',
    occurredAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    action: 'INTERNAL',
    entityType: 'INTERNAL',
    entityId: 'INTERNAL',
    before: 'CONFIDENTIAL',
    after: 'CONFIDENTIAL',
    reason: 'CONFIDENTIAL',
    approvalRef: 'INTERNAL',
    policyRef: 'INTERNAL',
    correlationId: 'INTERNAL',
    traceId: 'INTERNAL',
  },
);
export type AuditRow = typeof auditLog.$inferSelect;
