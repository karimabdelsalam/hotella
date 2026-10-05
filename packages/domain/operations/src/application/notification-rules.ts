import { Injectable } from '@nestjs/common';
import {
  ApprovalRequested,
  type EventEnvelope,
  EscalationTriggered,
  RestaurantReservationCreated,
  TaskAssigned,
} from '@hotella/contracts-events';
import type { z } from 'zod';
import { NotificationService } from './notification.service';

type Payload<T extends { payload: z.ZodType }> = z.infer<T['payload']>;

/**
 * Who is told what when the engine moves (Spec §25), as deterministic rules over the engine's events. Each rule only
 * records a notification intent; delivery is the dispatcher's job.
 */
@Injectable()
export class NotificationRules {
  static readonly consumes = [
    EscalationTriggered,
    ApprovalRequested,
    TaskAssigned,
    RestaurantReservationCreated,
  ] as const;

  constructor(private readonly notifications: NotificationService) {}

  async apply(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId) return;
    switch (envelope.event_type) {
      case EscalationTriggered.type: {
        const p = envelope.payload as Payload<typeof EscalationTriggered>;
        for (const roleCode of p.notify_roles)
          await this.notifications.notify({
            tenantId,
            propertyId,
            category: 'ESCALATION',
            templateKey: 'ops.notification.sla_escalation',
            params: { level: p.level, trigger: p.trigger },
            to: { type: 'ROLE', roleCode },
            priority:
              p.severity === 'CRITICAL' ? 'CRITICAL' : p.severity === 'WARNING' ? 'HIGH' : 'NORMAL',
            criticalOverride: p.severity === 'CRITICAL',
            source: { type: 'work_item', id: p.work_item_id },
          });
        return;
      }
      case ApprovalRequested.type: {
        const p = envelope.payload as Payload<typeof ApprovalRequested>;
        await this.notifications.notify({
          tenantId,
          propertyId,
          category: 'APPROVAL',
          templateKey: 'ops.notification.approval_requested',
          params: { kind: p.kind, risk: p.risk_level },
          to: { type: 'PERMISSION', permission: 'approval.decide' },
          priority:
            p.risk_level === 'CRITICAL' ? 'CRITICAL' : p.risk_level === 'HIGH' ? 'HIGH' : 'NORMAL',
          criticalOverride: p.risk_level === 'CRITICAL',
          source: { type: 'approval_request', id: p.approval_id },
        });
        return;
      }
      case TaskAssigned.type: {
        const p = envelope.payload as Payload<typeof TaskAssigned>;
        if (p.assignee.type !== 'USER') return;
        await this.notifications.notify({
          tenantId,
          propertyId,
          category: 'TASK',
          templateKey: 'ops.notification.task_assigned',
          to: { type: 'USER', userId: p.assignee.id },
          source: { type: 'task', id: p.task_id },
        });
        return;
      }
      case RestaurantReservationCreated.type: {
        // A booking the restaurant team did not take itself (guest app, concierge) is announced to whoever runs the
        // board; the notification carries the party, night and time, never the guest (rule 21).
        const p = envelope.payload as Payload<typeof RestaurantReservationCreated>;
        if (p.channel === 'STAFF') return;
        await this.notifications.notify({
          tenantId,
          propertyId,
          category: 'RESTAURANT',
          templateKey: 'ops.notification.restaurant_booked',
          params: {
            party: p.party_size,
            date: p.service_date,
            time: p.starts_at,
            channel: p.channel,
          },
          to: { type: 'PERMISSION', permission: 'restaurant.reservation.manage' },
          source: { type: 'restaurant_reservation', id: p.reservation_id },
        });
        return;
      }
    }
  }
}
