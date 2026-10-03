import { Inject, Injectable } from '@nestjs/common';
import {
  type EventEnvelope,
  GuestAnonymized,
  ServiceRequestStatusChanged,
  StayStatusChanged,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { isTerminal, statusForWorkItem } from '../domain/requests';
import { freeTextFieldCodes, type FieldDefinition } from '../domain/rules';
import { RequestRepositories } from '../infrastructure/request-repositories';
import { CatalogRepositories } from '../infrastructure/repositories';
import type { RequestRow } from '../infrastructure/schema';
import type { ServiceRequestStatus } from '../public';
import { RequestNotifier } from './request-notifier';

export const CATALOG_SOURCE = 'catalog';
/** The operations work kind of service requests. */
export const SERVICE_REQUEST_KIND = 'SERVICE_REQUEST';
export const SERVICE_REQUEST_ENTITY = 'service_request';

/**
 * How a request moves once it exists (API and worker): status changes with history and events, following the work
 * item, withdrawal when the stay leaves the house, and anonymization of the guest's words.
 */
@Injectable()
export class RequestLifecycle {
  constructor(
    private readonly repo: RequestRepositories,
    private readonly catalog: CatalogRepositories,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly notifier: RequestNotifier,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
  ) {}

  static readonly consumes = [WorkItemStatusChanged, StayStatusChanged, GuestAnonymized] as const;

  async apply(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id) return;
    const scope = { tenantId: envelope.tenant_id };
    if (envelope.event_type === WorkItemStatusChanged.type) {
      const e = WorkItemStatusChanged.parse(envelope);
      if (
        e.payload.kind !== SERVICE_REQUEST_KIND ||
        e.payload.source_entity_type !== SERVICE_REQUEST_ENTITY
      )
        return;
      await this.tx.run(async () => {
        const request = e.payload.source_entity_id
          ? await this.repo.getForUpdate(scope, e.payload.source_entity_id)
          : undefined;
        if (!request || !request.workItemId) return;
        // Follow the work item as it is now, not as the event says: late or repeated deliveries cannot move the
        // request backwards.
        const work = await this.ops.getWorkItem(request.tenantId, request.workItemId);
        if (!work) return;
        const to = statusForWorkItem(work.status);
        if (to === request.status) return;
        await this.move(request, to, { type: 'SYSTEM', id: null }, null);
      });
    } else if (envelope.event_type === StayStatusChanged.type) {
      // The stay left the house (PMS check-out, cancellation, no-show): asks nobody started are withdrawn.
      const e = StayStatusChanged.parse(envelope);
      if (!['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(e.payload.to)) return;
      await this.tx.run(async () => {
        for (const r of await this.repo.openOfStay(scope, e.payload.stay_id, ['OPEN'])) {
          const request = (await this.repo.getForUpdate(scope, r.id))!;
          if (request.status !== 'OPEN') continue;
          await this.move(request, 'CANCELLED', { type: 'SYSTEM', id: null }, 'STAY_ENDED');
          if (request.workItemId)
            await this.ops.cancelWorkItem(request.tenantId, request.workItemId, 'STAY_ENDED');
        }
      });
    } else if (envelope.event_type === GuestAnonymized.type) {
      const e = GuestAnonymized.parse(envelope);
      await this.tx.run(() => this.anonymize(scope, e.payload.guest_id));
    }
  }

  /** Clears the guest's own words (TEXT fields, reasons) from their requests and asks (Spec §69, rule 21). */
  private async anonymize(scope: TenantScope, guestId: string): Promise<void> {
    const textCodes = new Map<string, string[]>();
    const codesOf = async (versionId: string) => {
      if (!textCodes.has(versionId)) {
        const v = await this.catalog.version(scope, versionId);
        textCodes.set(
          versionId,
          v ? freeTextFieldCodes(v.requiredFields as FieldDefinition[]) : [],
        );
      }
      return textCodes.get(versionId)!;
    };
    const strip = (fields: unknown, codes: readonly string[]) => {
      const out = { ...(fields as Record<string, unknown>) };
      for (const c of codes) delete out[c];
      return out;
    };
    for (const r of await this.repo.ofGuest(scope, guestId)) {
      const codes = await codesOf(r.serviceVersionId);
      if (codes.length) await this.repo.update(scope, r.id, { fields: strip(r.fields, codes) });
      for (const ev of await this.repo.eventsOf(scope, r.id))
        if (ev.fields || ev.reason)
          await this.repo.setEventText(scope, ev.id, {
            ...(ev.fields ? { fields: strip(ev.fields, codes) } : {}),
            ...(ev.reason ? { reason: null } : {}),
          });
    }
    // The guest's asks related to someone else's request carry their words too.
    for (const ev of await this.repo.eventsByActor(scope, guestId)) {
      if (!ev.fields) continue;
      const parent = await this.repo.get(scope, ev.requestId);
      const codes = parent ? await codesOf(parent.serviceVersionId) : [];
      await this.repo.setEventText(scope, ev.id, { fields: strip(ev.fields, codes) });
    }
  }

  /** Records a status change, publishes it and tells the listener (inside the caller's transaction). */
  async move(
    request: RequestRow,
    to: ServiceRequestStatus,
    actor: { type: string; id: string | null },
    reason: string | null,
  ): Promise<RequestRow> {
    const scope = { tenantId: request.tenantId };
    const now = new Date();
    const updated = await this.repo.update(scope, request.id, {
      status: to,
      closedAt: isTerminal(to) ? now : null,
    });
    await this.repo.insertEvent({
      id: newId(),
      tenantId: request.tenantId,
      requestId: request.id,
      type: 'STATUS_CHANGED',
      fromStatus: request.status,
      toStatus: to,
      actorType: actor.type,
      actorId: isUuid(actor.id ?? '') ? actor.id : null,
      reason,
      occurredAt: now,
    });
    await this.events.publish(ServiceRequestStatusChanged, {
      tenantId: request.tenantId,
      propertyId: request.propertyId,
      source: CATALOG_SOURCE,
      aggregate: { type: SERVICE_REQUEST_ENTITY, id: request.id },
      payload: {
        request_id: request.id,
        service_code: request.serviceCode,
        stay_id: request.stayId,
        guest_id: request.guestId,
        from: request.status,
        to,
      },
    });
    await this.notifier.statusChanged(updated, actor.type);
    return updated;
  }
}
