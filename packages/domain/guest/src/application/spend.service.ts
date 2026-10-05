import { Inject, Injectable } from '@nestjs/common';
import { type EventEnvelope, PosCheckClosed, StayChargeRecorded } from '@hotella/contracts-events';
import {
  EXTERNAL_ENTITY,
  INTEGRATIONS_API,
  type IntegrationsPublicApi,
} from '@hotella/domain-integrations/public';
import { ActionGate } from '@hotella/platform-auth';
import {
  currentTransaction,
  isUuid,
  newId,
  type PropertyScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { GuestRepositories } from '../infrastructure/repositories';
import type { StayRow } from '../infrastructure/schema';
import { SpendRepositories } from '../infrastructure/spend-repositories';

/** Connectors whose reservation ids name stays. */
const PMS_STAY_CAPABILITIES: ReadonlySet<string> = new Set([
  'CHECKIN_EVENT',
  'RESERVATION_READ',
  'RESERVATION_LOOKUP',
]);

/**
 * Spend facts of stays (BUILD_PLAN 13.5): a closed POS check belongs to the stay its reservation reference names, else
 * to the one stay that was in the charged room when the check closed; with neither (a walk-in, a shared room) it is
 * not tied to anyone — never guessed (rule 16). Runs in the worker inside the idempotent consumer's transaction.
 */
@Injectable()
export class StaySpendService {
  static readonly consumes = [PosCheckClosed] as const;

  constructor(
    private readonly repo: GuestRepositories,
    private readonly spend: SpendRepositories,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
    private readonly events: EventPublisher,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async apply(envelope: EventEnvelope): Promise<void> {
    if (!currentTransaction())
      throw new Error('StaySpendService.apply must run inside a transaction');
    if (!envelope.tenant_id || !envelope.property_id) return;
    const e = PosCheckClosed.parse(envelope);
    const scope = { tenantId: envelope.tenant_id, propertyId: envelope.property_id };
    const closedAt = new Date(e.payload.closed_at);
    const stay = await this.stayOf(scope, e.payload, closedAt);
    if (!stay) {
      this.logger.debug({ event_id: envelope.event_id }, 'pos check not tied to a stay');
      return;
    }
    const charge = await this.spend.insert({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      stayId: stay.id,
      roomId: e.payload.room?.room_id ?? null,
      sourceEventId: envelope.event_id,
      outletCategory: e.payload.outlet_category,
      settlement: e.payload.settlement,
      totalMinor: e.payload.total_minor,
      currency: e.payload.currency,
      covers: e.payload.covers,
      closedAt,
    });
    if (!charge) return; // the same check event twice
    await this.events.publish(StayChargeRecorded, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: 'guest',
      aggregate: { type: 'stay', id: stay.id },
      occurredAt: closedAt,
      payload: {
        charge_id: charge.id,
        stay_id: stay.id,
        room_id: charge.roomId,
        outlet_category: e.payload.outlet_category,
        settlement: e.payload.settlement,
        total_minor: charge.totalMinor,
        currency: charge.currency,
        covers: charge.covers,
        closed_at: e.payload.closed_at,
      },
    });
  }

  private async stayOf(
    scope: PropertyScope,
    p: ReturnType<typeof PosCheckClosed.parse>['payload'],
    closedAt: Date,
  ): Promise<StayRow | null> {
    if (p.reservation) {
      // The POS quotes the PMS's reservation id: it resolves in the namespace of the property's PMS connectors, and
      // only when they agree on one stay.
      const pmsInstances = (
        await this.integrations.listInstances(scope.tenantId, scope.propertyId)
      ).filter(
        (i) =>
          i.id === p.reservation!.integration_instance_id ||
          i.effectiveCapabilities.some((c) => PMS_STAY_CAPABILITIES.has(c)),
      );
      const found = new Set<string>();
      for (const instance of pmsInstances) {
        const id = await this.integrations.resolveReference(
          scope.tenantId,
          instance.id,
          EXTERNAL_ENTITY.RESERVATION,
          p.reservation.external_id,
        );
        if (id) found.add(id);
      }
      const [only] = found.size === 1 ? [...found] : [];
      const stay = only ? await this.repo.stay(scope, only) : undefined;
      if (stay && stay.propertyId === scope.propertyId) return stay;
    }
    if (!p.room) return null;
    const inRoom = await this.spend.staysInRoomAt(scope, p.room.room_id, closedAt);
    return inRoom.length === 1 ? inRoom[0]! : null;
  }

  /** Staff read (`stay.read`): the stay's checks and totals per outlet category, settlement and currency. */
  get(scope: PropertyScope, stayId: string) {
    return this.gate.execute(
      { action: 'stay.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const stay = isUuid(stayId) ? await this.repo.stay(scope, stayId) : undefined;
          if (!stay || stay.propertyId !== scope.propertyId)
            throw AppError.notFound('guest.stay.not_found');
          const charges = await this.spend.chargesOf(scope, stay.id);
          const totals = new Map<
            string,
            {
              outletCategory: string;
              settlement: string;
              currency: string;
              totalMinor: number;
              checks: number;
              covers: number;
            }
          >();
          for (const c of charges) {
            const key = `${c.outletCategory}|${c.settlement}|${c.currency}`;
            const t = totals.get(key) ?? {
              outletCategory: c.outletCategory,
              settlement: c.settlement,
              currency: c.currency,
              totalMinor: 0,
              checks: 0,
              covers: 0,
            };
            t.totalMinor += c.totalMinor;
            t.checks += 1;
            t.covers += c.covers ?? 0;
            totals.set(key, t);
          }
          return {
            stayId: stay.id,
            totals: [...totals.values()],
            checks: charges.map((c) => ({
              id: c.id,
              outletCategory: c.outletCategory,
              settlement: c.settlement,
              totalMinor: c.totalMinor,
              currency: c.currency,
              covers: c.covers,
              closedAt: c.closedAt,
            })),
          };
        }),
    );
  }
}
