import {
  type EventDefinition,
  GuestStayRoomChanged,
  MessageReceived,
  StayChargeRecorded,
  TaskAssigned,
  WorkOrderCreated,
} from '@hotella/contracts-events';
import { describe, expect, it } from 'vitest';
import { projectEvent } from './twin-projection';

const T = '01900000-0000-7000-8000-00000000000a';
const P = '01900000-0000-7000-8000-00000000000b';
const id = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const envelope = (def: EventDefinition, payload: unknown) => ({
  event_id: id(999),
  event_type: def.type,
  event_version: def.version,
  tenant_id: T,
  property_id: P,
  source: 'test',
  source_reference: null,
  occurred_at: '2026-10-05T10:00:00Z',
  received_at: '2026-10-05T10:00:00Z',
  correlation_id: null,
  payload,
});

describe('twin projection (BUILD_PLAN 12.3)', () => {
  it('moves a stay to its new room (the old room edge ends) and checks out without a room', () => {
    expect(
      projectEvent(
        envelope(GuestStayRoomChanged, {
          stay_id: id(1),
          from_room_id: id(2),
          to_room_id: id(3),
          reason: 'ROOM_MOVE',
          at: '2026-10-05T10:00:00Z',
        }),
      ).at(-1),
    ).toEqual({
      op: 'link',
      from: { kind: 'STAY', id: id(1) },
      relation: 'IN_ROOM',
      to: { kind: 'LOCATION', id: id(3) },
      exclusive: true,
    });
    expect(
      projectEvent(
        envelope(GuestStayRoomChanged, {
          stay_id: id(1),
          from_room_id: id(3),
          to_room_id: null,
          reason: 'CHECK_OUT',
          at: '2026-10-05T10:00:00Z',
        }),
      ),
    ).toEqual([{ op: 'unlink', from: { kind: 'STAY', id: id(1) }, relation: 'IN_ROOM' }]);
  });

  it('hangs a POS check on its stay with amounts and outlet only (BUILD_PLAN 13.5)', () => {
    const ops = projectEvent(
      envelope(StayChargeRecorded, {
        charge_id: id(7),
        stay_id: id(1),
        room_id: id(3),
        outlet_category: 'BAR',
        settlement: 'ROOM_CHARGE',
        total_minor: 4500,
        currency: 'EGP',
        covers: null,
        closed_at: '2026-10-05T21:00:00Z',
      }),
    );
    expect(ops[0]).toMatchObject({
      op: 'node',
      ref: { kind: 'POS_CHECK', id: id(7) },
      attributes: { outlet: 'BAR', total_minor: 4500, currency: 'EGP' },
    });
    expect(ops.at(-1)).toEqual({
      op: 'link',
      from: { kind: 'STAY', id: id(1) },
      relation: 'HAS_CHARGE',
      to: { kind: 'POS_CHECK', id: id(7) },
    });
  });

  it('reassigns work from one person to the next, and ties a work order to its asset, place and work', () => {
    const ops = projectEvent(
      envelope(TaskAssigned, {
        task_id: id(10),
        work_item_id: id(11),
        assignee: { type: 'USER', id: id(12) },
        previous: { type: 'USER', id: id(13) },
      }),
    );
    expect(ops[0]).toEqual({
      op: 'unlink',
      from: { kind: 'WORK_ITEM', id: id(11) },
      relation: 'ASSIGNED_TO',
      to: { kind: 'STAFF', id: id(13) },
    });
    expect(ops.at(-1)).toMatchObject({ op: 'link', to: { kind: 'STAFF', id: id(12) } });
    const order = projectEvent(
      envelope(WorkOrderCreated, {
        work_order_id: id(20),
        work_item_id: id(21),
        number: 7,
        type: 'CORRECTIVE',
        source: 'GUEST_REQUEST',
        asset_id: id(22),
        location_id: id(23),
        symptom_code: 'NOT_COOLING',
      }),
    );
    expect(
      order
        .filter((o) => o.op === 'link')
        .map((o) => o.op === 'link' && `${o.from.kind}-${o.relation}-${o.to.kind}`),
    ).toEqual([
      'WORK_ORDER-TRACKS-WORK_ITEM',
      'WORK_ORDER-AT-LOCATION',
      'WORK_ORDER-ON_ASSET-ASSET',
      'ASSET-AT-LOCATION',
    ]);
    // Codes only: nothing a person wrote reaches the twin.
    expect(order[0]).toEqual({
      op: 'node',
      ref: { kind: 'WORK_ORDER', id: id(20) },
      state: 'OPEN',
      attributes: { type: 'CORRECTIVE', source: 'GUEST_REQUEST', symptom: 'NOT_COOLING' },
    });
  });

  it('ignores events it does not follow', () => {
    expect(projectEvent(envelope(MessageReceived, {}))).toEqual([]);
  });
});
