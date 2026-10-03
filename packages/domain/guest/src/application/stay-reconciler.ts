import { Inject, Injectable } from '@nestjs/common';
import { type EventEnvelope, ReconciliationSnapshotCompleted } from '@hotella/contracts-events';
import {
  EXTERNAL_ENTITY,
  INTEGRATIONS_API,
  type IntegrationsPublicApi,
} from '@hotella/domain-integrations/public';
import { currentTransaction } from '@hotella/platform-database';
import { type PlatformStay, reconcileInHouse } from '../domain/reconcile';
import { GuestRepositories } from '../infrastructure/repositories';
import { STAY_ENTITY } from './stay-projector';

/**
 * The stay side of reconciliation (Spec §52): when the PMS finished reporting its in-house list, compare it with the
 * platform's stays and report findings back to the Integration Platform, which opens exceptions for differences.
 * Runs in the worker inside the idempotent consumer's transaction.
 */
@Injectable()
export class StayReconciler {
  static readonly consumes = [ReconciliationSnapshotCompleted] as const;

  constructor(
    private readonly repo: GuestRepositories,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
  ) {}

  async apply(envelope: EventEnvelope): Promise<void> {
    if (!currentTransaction())
      throw new Error('StayReconciler.apply must run inside a transaction');
    const e = ReconciliationSnapshotCompleted.parse(envelope);
    const tenantId = e.tenant_id!;
    const snapshot = await this.integrations.reconciliationSnapshot(tenantId, e.payload.run_id);
    if (!snapshot || snapshot.status !== 'RUNNING') return;
    const scope = { tenantId, propertyId: snapshot.propertyId };
    const instanceId = snapshot.integrationInstanceId;

    const platformStay = async (
      stayId: string,
      externalId: string | null,
    ): Promise<PlatformStay | null> => {
      const stay = await this.repo.stay(scope, stayId);
      if (!stay) return null;
      const open = await this.repo.openAssignment(scope, stay.id);
      return { stayId: stay.id, externalId, status: stay.status, roomId: open?.roomId ?? null };
    };

    const known = new Map<string, PlatformStay>();
    for (const entry of snapshot.entries) {
      const stayId = await this.integrations.resolveReference(
        tenantId,
        instanceId,
        EXTERNAL_ENTITY.RESERVATION,
        entry.externalId,
      );
      const stay = stayId ? await platformStay(stayId, entry.externalId) : null;
      if (stay) known.set(entry.externalId, stay);
    }
    const inHouse: PlatformStay[] = [];
    for (const stay of await this.repo.inHouseStays(scope)) {
      const refs = await this.integrations.referencesFor(tenantId, STAY_ENTITY, stay.id);
      const ref = refs.find(
        (r) =>
          r.integrationInstanceId === instanceId &&
          r.externalEntityType === EXTERNAL_ENTITY.RESERVATION,
      );
      // Stays that came from another integration are that integration's business.
      if (!ref) continue;
      const open = await this.repo.openAssignment(scope, stay.id);
      inHouse.push({
        stayId: stay.id,
        externalId: ref.externalId,
        status: stay.status,
        roomId: open?.roomId ?? null,
      });
    }
    const findings = reconcileInHouse(snapshot.entries, known, inHouse);
    await this.integrations.completeReconciliation(tenantId, snapshot.runId, findings);
  }
}
