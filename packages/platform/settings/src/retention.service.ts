import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  DATABASE,
  type Database,
  type DataClass,
  executor,
  newId,
  TransactionRunner,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { retentionPolicies, type RetentionPolicyRow } from './schema/settings';
import { actingTenant } from './scope';

export interface RetentionPolicyInput {
  readonly scope: 'PLATFORM' | 'TENANT';
  readonly tenantId?: string | null;
  readonly dataClass: DataClass;
  readonly entityType?: string | null;
  readonly retainDays: number;
  readonly action: 'DELETE' | 'ANONYMIZE' | 'ARCHIVE';
  readonly legalHold?: boolean;
  readonly reason?: string | null;
}

/**
 * Retention framework (Spec §69): platform defaults and tenant overrides per data class (optionally per entity type).
 * Purge/anonymize jobs are owned by each module and read `effectiveFor()`; a legal hold suspends them.
 */
@Injectable()
export class RetentionPolicyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  /** Policies visible to a tenant: its overrides first, then platform defaults. */
  async list(named?: string | null): Promise<RetentionPolicyRow[]> {
    const actor = this.actors.require();
    const tenantId = actor.isPlatformAdmin && !named ? null : actingTenant(actor, named);
    return this.gate.execute({ action: 'config.read', tenantId }, () =>
      executor(this.db)
        .select()
        .from(retentionPolicies)
        .where(
          tenantId
            ? or(isNull(retentionPolicies.tenantId), eq(retentionPolicies.tenantId, tenantId))
            : isNull(retentionPolicies.tenantId),
        )
        .orderBy(asc(retentionPolicies.dataClass), asc(retentionPolicies.entityType)),
    );
  }

  /** The policy a purge job applies: tenant+entity → tenant+class → platform+entity → platform+class. */
  async effectiveFor(
    tenantId: string,
    dataClass: DataClass,
    entityType: string,
  ): Promise<RetentionPolicyRow | null> {
    const rows = await executor(this.db)
      .select()
      .from(retentionPolicies)
      .where(
        and(
          eq(retentionPolicies.dataClass, dataClass),
          or(isNull(retentionPolicies.tenantId), eq(retentionPolicies.tenantId, tenantId)),
          or(isNull(retentionPolicies.entityType), eq(retentionPolicies.entityType, entityType)),
        ),
      );
    const rank = (r: RetentionPolicyRow) => (r.tenantId ? 0 : 2) + (r.entityType ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b))[0] ?? null;
  }

  upsert(input: RetentionPolicyInput): Promise<RetentionPolicyRow> {
    const actor = this.actors.require();
    if (input.scope === 'PLATFORM' && !actor.isPlatformAdmin)
      throw AppError.forbidden('platform.forbidden', { permission: 'config.manage' });
    const tenantId = input.scope === 'PLATFORM' ? null : actingTenant(actor, input.tenantId);
    return this.gate.execute({ action: 'config.manage', tenantId }, () =>
      this.tx.run(async () => {
        const [row] = await executor(this.db)
          .insert(retentionPolicies)
          .values({
            id: newId(),
            tenantId,
            dataClass: input.dataClass,
            entityType: input.entityType ?? null,
            retainDays: input.retainDays,
            action: input.action,
            legalHold: input.legalHold ?? false,
          })
          .onConflictDoUpdate({
            target: [
              retentionPolicies.tenantId,
              retentionPolicies.dataClass,
              retentionPolicies.entityType,
            ],
            set: {
              retainDays: input.retainDays,
              action: input.action,
              legalHold: input.legalHold ?? false,
              version: sql`${retentionPolicies.version} + 1`,
              updatedAt: sql`now()`,
            },
          })
          .returning();
        await this.audit.record({
          action: 'platform.retention_policy.upsert',
          entityType: 'retention_policy',
          entityId: row!.id,
          tenantId,
          propertyId: null,
          after: row,
          reason: input.reason ?? null,
        });
        return row!;
      }),
    );
  }
}
