import { Injectable } from '@nestjs/common';
import {
  ComplaintOpened,
  type EventEnvelope,
  eventName,
  HkJobStatusChanged,
  ServiceRequestCreated,
  ServiceRequestStatusChanged,
  SlaBreached,
  TelemetryAlarmRaised,
  WorkOrderClosed,
} from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { InsightRepositories } from '../infrastructure/insight-repositories';
import { TwinRepositories } from '../infrastructure/twin-repositories';

/** The events insights count (BUILD_PLAN 12.4). */
export const SIGNAL_EVENTS: readonly string[] = [
  WorkOrderClosed.name,
  SlaBreached.name,
  ComplaintOpened.name,
  HkJobStatusChanged.name,
  ServiceRequestCreated.name,
  ServiceRequestStatusChanged.name,
  TelemetryAlarmRaised.name,
];

/**
 * Keeps the facts detectors count, from domain events (ids and codes only). Runs in the twin's consumer after the twin
 * was updated, so it can add what the event itself does not say — the department of a breached work item, the room
 * a complaining stay was in at that moment.
 */
@Injectable()
export class SignalRecorder {
  constructor(
    private readonly insights: InsightRepositories,
    private readonly twin: TwinRepositories,
  ) {}

  async record(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId) return;
    const at = new Date(envelope.occurred_at);
    const keep = (signal: string, subjectKind: string, subjectRef: string, codes: object) =>
      this.insights.insertSignal({
        id: newId(),
        tenantId,
        propertyId,
        signal,
        subjectKind,
        subjectRef,
        codes,
        occurredAt: at,
        sourceEventId: envelope.event_id,
      });
    switch (eventName(envelope.event_type, envelope.event_version)) {
      case WorkOrderClosed.name: {
        const p = WorkOrderClosed.parse(envelope).payload;
        return keep('WORK_ORDER_CLOSED', 'WORK_ORDER', p.work_order_id, {
          asset: p.asset_id,
          type: p.type,
          status: p.status,
          failure_mode: p.failure_mode_code,
          cause: p.cause_code,
        });
      }
      case SlaBreached.name: {
        const p = SlaBreached.parse(envelope).payload;
        const work = await this.twin.attributes(tenantId, {
          kind: 'WORK_ITEM',
          id: p.work_item_id,
        });
        return keep('SLA_BREACHED', 'WORK_ITEM', p.work_item_id, {
          target: p.target,
          department: typeof work?.department === 'string' ? work.department : null,
          kind: typeof work?.kind === 'string' ? work.kind : null,
        });
      }
      case ComplaintOpened.name: {
        const p = ComplaintOpened.parse(envelope).payload;
        const room = p.stay_id
          ? await this.twin.targetAt(tenantId, { kind: 'STAY', id: p.stay_id }, 'IN_ROOM', at)
          : undefined;
        return keep('COMPLAINT_OPENED', 'COMPLAINT', p.complaint_id, {
          category: p.category_code,
          severity: p.severity,
          room: room ?? null,
        });
      }
      case HkJobStatusChanged.name: {
        const p = HkJobStatusChanged.parse(envelope).payload;
        return keep('HK_JOB_STATUS', 'HK_JOB', p.job_id, {
          room: p.room_id,
          from: p.from,
          to: p.to,
        });
      }
      // What the quality metrics need about requests (BUILD_PLAN 12.6): who created them, and what became of them.
      case ServiceRequestCreated.name: {
        const p = ServiceRequestCreated.parse(envelope).payload;
        return keep('SERVICE_REQUEST_CREATED', 'SERVICE_REQUEST', p.request_id, {
          source: p.source,
          service: p.service_code,
        });
      }
      case ServiceRequestStatusChanged.name: {
        const p = ServiceRequestStatusChanged.parse(envelope).payload;
        return keep('SERVICE_REQUEST_STATUS', 'SERVICE_REQUEST', p.request_id, {
          from: p.from,
          to: p.to,
        });
      }
      // Building telemetry alarms (BUILD_PLAN 13.2): what fired, on which equipment or place.
      case TelemetryAlarmRaised.name: {
        const p = TelemetryAlarmRaised.parse(envelope).payload;
        return keep('TELEMETRY_ALARM', 'TELEMETRY_ALARM', p.alarm_id, {
          asset: p.asset_id,
          location: p.location_id,
          quantity: p.quantity,
          rule: p.rule_kind,
          severity: p.severity,
        });
      }
      default:
        return;
    }
  }
}
