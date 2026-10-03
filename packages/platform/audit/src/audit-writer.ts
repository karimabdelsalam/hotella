import { Inject, Injectable } from '@nestjs/common';
import { currentTransaction, DATABASE, type Database, executor } from '@hotella/platform-database';
import { type ActorRef, RequestContext } from '@hotella/platform-observability';
import { redactForAudit } from './redact';
import { auditLog } from './schema/audit';

export interface AuditEntry {
  /** `<domain>.<entity>.<verb>`, e.g. `org.property.update`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly approvalRef?: string | null;
  readonly policyRef?: string | null;
  /** Defaults to the request scope. */
  readonly tenantId?: string | null;
  readonly propertyId?: string | null;
  /** Defaults to the request actor, else SYSTEM. */
  readonly actor?: ActorRef;
  /**
   * Security events that must survive the request failing (e.g. an account lockout) are written outside the
   * business transaction. Everything else belongs to the transaction of the change it describes.
   */
  readonly allowAutocommit?: boolean;
}

export class AuditRequiresTransactionError extends Error {
  constructor(action: string) {
    super(
      `Audit entry "${action}" must be written inside the transaction of the change it records`,
    );
    this.name = 'AuditRequiresTransactionError';
  }
}

/** Writes `audit.audit_log` rows (CLAUDE.md rule 5): who, what, on which entity, why, under which approval/policy. */
@Injectable()
export class AuditWriter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ctx: RequestContext,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    if (!currentTransaction() && !entry.allowAutocommit)
      throw new AuditRequiresTransactionError(entry.action);
    const actor = entry.actor ?? this.ctx.actor ?? { type: 'SYSTEM' as const, id: null };
    await executor(this.db)
      .insert(auditLog)
      .values({
        tenantId: entry.tenantId !== undefined ? entry.tenantId : this.ctx.tenantId,
        propertyId: entry.propertyId !== undefined ? entry.propertyId : this.ctx.propertyId,
        actorType: actor.type,
        actorId: actor.id,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before === undefined ? null : redactForAudit(entry.before),
        after: entry.after === undefined ? null : redactForAudit(entry.after),
        reason: entry.reason ?? null,
        approvalRef: entry.approvalRef ?? null,
        policyRef: entry.policyRef ?? null,
        correlationId: this.ctx.correlationId,
        traceId: this.ctx.traceId,
      });
  }
}
