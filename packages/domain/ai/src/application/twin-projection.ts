import {
  ComplaintOpened,
  ComplaintResolved,
  ConversationOpened,
  type EventEnvelope,
  eventName,
  GuestAnonymized,
  GuestStayRoomChanged,
  InspectionCompleted,
  InspectionFindingRaised,
  LostFoundItemDisposed,
  LostFoundItemRegistered,
  LostFoundItemReleased,
  RoomRestrictionChanged,
  ServiceRequestCreated,
  ServiceRequestStatusChanged,
  StayCreated,
  StayStatusChanged,
  TaskAssigned,
  WorkItemCreated,
  WorkItemStatusChanged,
  WorkOrderClosed,
  WorkOrderCreated,
} from '@hotella/contracts-events';
import type { TwinKind, TwinOp, TwinRef } from '../domain/twin';

const ref = (kind: TwinKind, id: string): TwinRef => ({ kind, id });

/**
 * How each domain event moves the twin (BUILD_PLAN 12.3). Pure: the same event always gives the same operations, so
 * a redelivered or replayed event changes nothing more. Only ids, states and codes are taken from a payload.
 */
const PROJECTIONS: Record<string, (envelope: EventEnvelope) => TwinOp[]> = {
  [StayCreated.name]: (envelope) => {
    const p = StayCreated.parse(envelope).payload;
    return [
      { op: 'node', ref: ref('STAY', p.stay_id), state: p.status },
      { op: 'node', ref: ref('GUEST', p.primary_guest_id) },
      {
        op: 'link',
        from: ref('STAY', p.stay_id),
        relation: 'HAS_GUEST',
        to: ref('GUEST', p.primary_guest_id),
      },
    ];
  },
  [StayStatusChanged.name]: (envelope) => {
    const p = StayStatusChanged.parse(envelope).payload;
    return [{ op: 'node', ref: ref('STAY', p.stay_id), state: p.to }];
  },
  [GuestStayRoomChanged.name]: (envelope) => {
    const p = GuestStayRoomChanged.parse(envelope).payload;
    const stay = ref('STAY', p.stay_id);
    // The previous room stays in the history (the edge ends, rule 10); a check-out leaves the stay without a room.
    return p.to_room_id
      ? [
          { op: 'node', ref: stay },
          { op: 'node', ref: ref('LOCATION', p.to_room_id) },
          {
            op: 'link',
            from: stay,
            relation: 'IN_ROOM',
            to: ref('LOCATION', p.to_room_id),
            exclusive: true,
          },
        ]
      : [{ op: 'unlink', from: stay, relation: 'IN_ROOM' }];
  },
  [GuestAnonymized.name]: (envelope) => {
    const p = GuestAnonymized.parse(envelope).payload;
    return [{ op: 'node', ref: ref('GUEST', p.guest_id), state: 'ANONYMIZED' }];
  },
  [WorkItemCreated.name]: (envelope) => {
    const p = WorkItemCreated.parse(envelope).payload;
    const work = ref('WORK_ITEM', p.work_item_id);
    return [
      {
        op: 'node',
        ref: work,
        state: 'OPEN',
        attributes: { kind: p.kind, priority: p.priority, department: p.department_code },
      },
      ...(p.location_id
        ? ([
            { op: 'node', ref: ref('LOCATION', p.location_id) },
            { op: 'link', from: work, relation: 'AT', to: ref('LOCATION', p.location_id) },
          ] as const)
        : []),
      ...(p.stay_id
        ? ([
            { op: 'node', ref: ref('STAY', p.stay_id) },
            { op: 'link', from: work, relation: 'FOR_STAY', to: ref('STAY', p.stay_id) },
          ] as const)
        : []),
    ];
  },
  [WorkItemStatusChanged.name]: (envelope) => {
    const p = WorkItemStatusChanged.parse(envelope).payload;
    return [{ op: 'node', ref: ref('WORK_ITEM', p.work_item_id), state: p.to }];
  },
  [TaskAssigned.name]: (envelope) => {
    const p = TaskAssigned.parse(envelope).payload;
    const work = ref('WORK_ITEM', p.work_item_id);
    const ops: TwinOp[] = [];
    if (p.previous?.type === 'USER')
      ops.push({
        op: 'unlink',
        from: work,
        relation: 'ASSIGNED_TO',
        to: ref('STAFF', p.previous.id),
      });
    if (p.assignee.type === 'USER')
      ops.push(
        { op: 'node', ref: work },
        { op: 'node', ref: ref('STAFF', p.assignee.id) },
        { op: 'link', from: work, relation: 'ASSIGNED_TO', to: ref('STAFF', p.assignee.id) },
      );
    return ops;
  },
  [WorkOrderCreated.name]: (envelope) => {
    const p = WorkOrderCreated.parse(envelope).payload;
    const order = ref('WORK_ORDER', p.work_order_id);
    const location = ref('LOCATION', p.location_id);
    return [
      {
        op: 'node',
        ref: order,
        state: 'OPEN',
        attributes: { type: p.type, source: p.source, symptom: p.symptom_code },
      },
      { op: 'node', ref: ref('WORK_ITEM', p.work_item_id) },
      { op: 'node', ref: location },
      { op: 'link', from: order, relation: 'TRACKS', to: ref('WORK_ITEM', p.work_item_id) },
      { op: 'link', from: order, relation: 'AT', to: location },
      ...(p.asset_id
        ? ([
            { op: 'node', ref: ref('ASSET', p.asset_id) },
            { op: 'link', from: order, relation: 'ON_ASSET', to: ref('ASSET', p.asset_id) },
            // Work on an asset happens where the asset is.
            {
              op: 'link',
              from: ref('ASSET', p.asset_id),
              relation: 'AT',
              to: location,
              exclusive: true,
            },
          ] as const)
        : []),
    ];
  },
  [WorkOrderClosed.name]: (envelope) => {
    const p = WorkOrderClosed.parse(envelope).payload;
    return [
      {
        op: 'node',
        ref: ref('WORK_ORDER', p.work_order_id),
        state: p.status,
        attributes: {
          failure_mode: p.failure_mode_code,
          cause: p.cause_code,
          resolution: p.resolution_code,
          downtime_minutes: p.downtime_minutes,
        },
      },
    ];
  },
  [ServiceRequestCreated.name]: (envelope) => {
    const p = ServiceRequestCreated.parse(envelope).payload;
    const request = ref('SERVICE_REQUEST', p.request_id);
    return [
      {
        op: 'node',
        ref: request,
        state: 'OPEN',
        attributes: { service: p.service_code, source: p.source },
      },
      { op: 'node', ref: ref('STAY', p.stay_id) },
      { op: 'node', ref: ref('GUEST', p.guest_id) },
      { op: 'node', ref: ref('WORK_ITEM', p.work_item_id) },
      { op: 'link', from: request, relation: 'FOR_STAY', to: ref('STAY', p.stay_id) },
      { op: 'link', from: request, relation: 'BY_GUEST', to: ref('GUEST', p.guest_id) },
      { op: 'link', from: request, relation: 'TRACKS', to: ref('WORK_ITEM', p.work_item_id) },
      ...(p.room_id
        ? ([
            { op: 'node', ref: ref('LOCATION', p.room_id) },
            { op: 'link', from: request, relation: 'AT', to: ref('LOCATION', p.room_id) },
          ] as const)
        : []),
    ];
  },
  [ServiceRequestStatusChanged.name]: (envelope) => {
    const p = ServiceRequestStatusChanged.parse(envelope).payload;
    return [{ op: 'node', ref: ref('SERVICE_REQUEST', p.request_id), state: p.to }];
  },
  [ComplaintOpened.name]: (envelope) => {
    const p = ComplaintOpened.parse(envelope).payload;
    const complaint = ref('COMPLAINT', p.complaint_id);
    return [
      {
        op: 'node',
        ref: complaint,
        state: 'OPEN',
        attributes: { category: p.category_code, severity: p.severity, source: p.source },
      },
      ...(p.stay_id
        ? ([
            { op: 'node', ref: ref('STAY', p.stay_id) },
            { op: 'link', from: complaint, relation: 'FOR_STAY', to: ref('STAY', p.stay_id) },
          ] as const)
        : []),
    ];
  },
  [ComplaintResolved.name]: (envelope) => {
    const p = ComplaintResolved.parse(envelope).payload;
    return [
      {
        op: 'node',
        ref: ref('COMPLAINT', p.complaint_id),
        state: 'RESOLVED',
        attributes: { open_minutes: p.open_minutes },
      },
    ];
  },
  [ConversationOpened.name]: (envelope) => {
    const p = ConversationOpened.parse(envelope).payload;
    const conversation = ref('CONVERSATION', p.conversation_id);
    return [
      { op: 'node', ref: conversation, state: 'OPEN', attributes: { channel: p.channel_type } },
      ...(p.stay_id
        ? ([
            { op: 'node', ref: ref('STAY', p.stay_id) },
            { op: 'link', from: conversation, relation: 'FOR_STAY', to: ref('STAY', p.stay_id) },
          ] as const)
        : []),
      ...(p.guest_id
        ? ([
            { op: 'node', ref: ref('GUEST', p.guest_id) },
            { op: 'link', from: conversation, relation: 'BY_GUEST', to: ref('GUEST', p.guest_id) },
          ] as const)
        : []),
    ];
  },
  [InspectionCompleted.name]: (envelope) => {
    const p = InspectionCompleted.parse(envelope).payload;
    const inspection = ref('INSPECTION', p.inspection_id);
    return [
      {
        op: 'node',
        ref: inspection,
        state: p.result,
        attributes: { template: p.template_code, score: p.score, source: p.source },
      },
      { op: 'node', ref: ref('LOCATION', p.location_id) },
      { op: 'link', from: inspection, relation: 'AT', to: ref('LOCATION', p.location_id) },
      ...(p.asset_id
        ? ([
            { op: 'node', ref: ref('ASSET', p.asset_id) },
            { op: 'link', from: inspection, relation: 'ON_ASSET', to: ref('ASSET', p.asset_id) },
          ] as const)
        : []),
    ];
  },
  [InspectionFindingRaised.name]: (envelope) => {
    const p = InspectionFindingRaised.parse(envelope).payload;
    if (!p.work_item_id) return [];
    return [
      { op: 'node', ref: ref('INSPECTION', p.inspection_id) },
      { op: 'node', ref: ref('WORK_ITEM', p.work_item_id) },
      {
        op: 'link',
        from: ref('INSPECTION', p.inspection_id),
        relation: 'RAISED',
        to: ref('WORK_ITEM', p.work_item_id),
      },
    ];
  },
  [LostFoundItemRegistered.name]: (envelope) => {
    const p = LostFoundItemRegistered.parse(envelope).payload;
    const item = ref('LOST_ITEM', p.item_id);
    return [
      {
        op: 'node',
        ref: item,
        state: p.kind === 'FOUND' ? 'FOUND' : 'REPORTED_LOST',
        attributes: { category: p.category, valuable: p.valuable },
      },
      ...(p.stay_id
        ? ([
            { op: 'node', ref: ref('STAY', p.stay_id) },
            { op: 'link', from: item, relation: 'FOR_STAY', to: ref('STAY', p.stay_id) },
          ] as const)
        : []),
    ];
  },
  [RoomRestrictionChanged.name]: (envelope) => {
    const p = RoomRestrictionChanged.parse(envelope).payload;
    // Out of order / service / blocked, as a code on the room (the pulse counts restricted rooms).
    return [
      {
        op: 'node',
        ref: ref('LOCATION', p.room_id),
        attributes: { restriction: p.active ? p.kind : null },
      },
    ];
  },
  [LostFoundItemReleased.name]: (envelope) => {
    const p = LostFoundItemReleased.parse(envelope).payload;
    return [{ op: 'node', ref: ref('LOST_ITEM', p.item_id), state: 'RELEASED' }];
  },
  [LostFoundItemDisposed.name]: (envelope) => {
    const p = LostFoundItemDisposed.parse(envelope).payload;
    return [{ op: 'node', ref: ref('LOST_ITEM', p.item_id), state: 'DISPOSED' }];
  },
};

/** The events the twin follows. */
export const TWIN_EVENTS: readonly string[] = Object.keys(PROJECTIONS);

/** What an event changes in the twin (nothing for an event it does not follow). */
export function projectEvent(envelope: EventEnvelope): TwinOp[] {
  return PROJECTIONS[eventName(envelope.event_type, envelope.event_version)]?.(envelope) ?? [];
}
