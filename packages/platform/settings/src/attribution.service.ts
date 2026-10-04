import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditWriter } from '@hotella/platform-audit';
import { ActorStore } from '@hotella/platform-auth';
import { DATABASE, type Database, executor, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { type Attribution, attributionFor } from './attribution';
import { attributionPolicies, type AttributionPolicyRow } from './schema/settings';

/**
 * The "Powered by Planova" attribution (Spec invariant 33, CLAUDE.md rule 15). Brand profiles cannot touch it; only a
 * platform administrator can hide it for a tenant, and only by citing the white-label entitlement that allows it
 * (the licensing context verifies the reference from Phase 11; the database refuses a hidden policy without one).
 */
@Injectable()
export class AttributionPolicyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  async resolve(tenantId: string): Promise<Attribution> {
    const row = await executor(this.db)
      .select()
      .from(attributionPolicies)
      .where(eq(attributionPolicies.tenantId, tenantId))
      .then((r) => r[0]);
    return attributionFor(row);
  }

  /** Tenants whose attribution is hidden (the licensing context checks their white-label entitlement daily). */
  async hiddenTenants(): Promise<string[]> {
    const rows = await executor(this.db)
      .select({ tenantId: attributionPolicies.tenantId })
      .from(attributionPolicies)
      .where(eq(attributionPolicies.showPoweredBy, false));
    return rows.map((r) => r.tenantId);
  }

  /**
   * Shows the attribution again — always allowed, it is the safe default (used when the white-label entitlement that
   * justified hiding it has ended). Audited with the reason; a no-op when it is already shown.
   */
  async restore(tenantId: string, reason: string): Promise<boolean> {
    return this.tx.run(async () => {
      const [row] = await executor(this.db)
        .update(attributionPolicies)
        .set({
          showPoweredBy: true,
          overrideEntitlementRef: null,
          version: sql`${attributionPolicies.version} + 1`,
        })
        .where(
          sql`${attributionPolicies.tenantId} = ${tenantId} and ${attributionPolicies.showPoweredBy} = false`,
        )
        .returning();
      if (!row) return false;
      await this.audit.record({
        action: 'platform.attribution_policy.restore',
        entityType: 'attribution_policy',
        entityId: tenantId,
        tenantId,
        propertyId: null,
        before: { showPoweredBy: false },
        after: { showPoweredBy: true },
        reason,
      });
      return true;
    });
  }

  /** Control-plane operation (the licensing context's `/control/tenants/:id/attribution` checks WHITE_LABEL). */
  set(
    tenantId: string,
    policy: { showPoweredBy: boolean; overrideEntitlementRef: string | null },
    reason: string,
  ): Promise<AttributionPolicyRow> {
    const actor = this.actors.require();
    if (!actor.isPlatformAdmin)
      throw AppError.forbidden('platform.forbidden', { permission: 'org.tenant.manage' });
    if (!policy.showPoweredBy && !policy.overrideEntitlementRef)
      throw new AppError(
        'platform.attribution.entitlement_required',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    return this.tx.run(async () => {
      const before = await executor(this.db)
        .select()
        .from(attributionPolicies)
        .where(eq(attributionPolicies.tenantId, tenantId))
        .then((r) => r[0]);
      const [row] = await executor(this.db)
        .insert(attributionPolicies)
        .values({ tenantId, ...policy, updatedBy: actor.id })
        .onConflictDoUpdate({
          target: attributionPolicies.tenantId,
          set: { ...policy, updatedBy: actor.id, version: sql`${attributionPolicies.version} + 1` },
        })
        .returning();
      await this.audit.record({
        action: 'platform.attribution_policy.set',
        entityType: 'attribution_policy',
        entityId: tenantId,
        tenantId,
        propertyId: null,
        before: before ?? null,
        after: row,
        reason,
        policyRef: policy.overrideEntitlementRef,
      });
      return row!;
    });
  }
}
