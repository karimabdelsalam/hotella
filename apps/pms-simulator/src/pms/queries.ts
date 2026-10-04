import {
  MAX_QUERY_ROWS,
  type PmsProfileRow,
  pmsQueryParams,
  type PmsReservationRow,
  type PmsRoomRow,
} from '@hotella/contracts-connectors';
import type { SimGuest, SimReservation, SimulatedPms } from './hotel';

/**
 * The simulator's answers to the standard PMS reads (link protocol 2, ADR-0019): what OPERA's database would return
 * through the data contract, computed from the simulated hotel. The .NET agent's OPERA database fixture is generated
 * from the same rows (`databaseFixture`), so both agents answer alike.
 */
export function answerQuery(
  pms: SimulatedPms,
  queryType: string,
  rawParams: unknown,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  const all = [...pms.reservations.values()];
  const cap = (rows: Record<string, unknown>[]) => ({
    rows: rows.slice(0, MAX_QUERY_ROWS),
    truncated: rows.length > MAX_QUERY_ROWS,
  });
  switch (queryType) {
    case 'LOOKUP_RESERVATION': {
      const p = pmsQueryParams.LOOKUP_RESERVATION.parse(rawParams);
      return cap(
        all
          .filter((r) =>
            p.reservation_id ? r.id === p.reservation_id : r.confirmation === p.confirmation_number,
          )
          .map(reservationRow),
      );
    }
    case 'LIST_ARRIVALS': {
      const p = pmsQueryParams.LIST_ARRIVALS.parse(rawParams);
      return cap(
        all
          .filter((r) => r.arrival >= p.from && r.arrival <= p.to && r.status !== 'CANCELLED')
          .map(reservationRow),
      );
    }
    case 'IN_HOUSE':
      pmsQueryParams.IN_HOUSE.parse(rawParams);
      return cap(all.filter((r) => r.status === 'IN_HOUSE').map(reservationRow));
    case 'LOOKUP_PROFILE': {
      const p = pmsQueryParams.LOOKUP_PROFILE.parse(rawParams);
      const guest = all
        .flatMap((r) => [r.guest, ...r.sharers])
        .find((g) => (g.profileId ?? '') === p.profile_id);
      return cap(guest ? [profileRow(guest)] : []);
    }
    case 'ROOM_INVENTORY':
      pmsQueryParams.ROOM_INVENTORY.parse(rawParams);
      return cap(roomRows(pms));
    default:
      throw new Error(`unknown query ${queryType}`);
  }
}

export function reservationRow(r: SimReservation): PmsReservationRow & Record<string, unknown> {
  return {
    reservation_id: r.id,
    confirmation_number: r.confirmation,
    status: r.status,
    arrival_date: r.arrival,
    departure_date: r.departure,
    eta: r.eta && /T(\d{2}:\d{2})/.test(r.eta) ? /T(\d{2}:\d{2})/.exec(r.eta)![1]! : null,
    adults: r.adults,
    children: r.children,
    room_number: r.room ?? null,
    room_type: null,
    rate_code: r.rate ?? null,
    market_code: r.market ?? null,
    profile_id: r.guest.profileId ?? null,
    share_of: null,
  };
}

export function profileRow(g: SimGuest): PmsProfileRow & Record<string, unknown> {
  return {
    profile_id: g.profileId ?? '',
    title: g.title ?? null,
    first_name: g.first,
    last_name: g.last ?? null,
    language: g.language ?? null,
    vip_code: g.vip ?? null,
    email: g.email ?? null,
    phone: g.phone ?? null,
  };
}

/** Every room the simulated hotel knows: occupied, written back to, or restricted. */
export function roomRows(pms: SimulatedPms): Array<PmsRoomRow & Record<string, unknown>> {
  const numbers = new Set<string>();
  for (const r of pms.reservations.values()) if (r.room) numbers.add(r.room);
  for (const n of pms.roomStatuses.keys()) numbers.add(n);
  for (const n of pms.restrictions.keys()) numbers.add(n);
  return [...numbers]
    .sort()
    .map((n) => ({ room_number: n, room_type: null, floor: n.slice(0, -2) || null }));
}

/** OPERA's reservation statuses for the simulator's (data contract v1). */
const OPERA_STATUS: Record<SimReservation['status'], string> = {
  RESERVED: 'RESERVED',
  IN_HOUSE: 'CHECKED IN',
  CHECKED_OUT: 'CHECKED OUT',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO SHOW',
};

/**
 * The simulated hotel as the .NET agent's OPERA database fixture (`FixtureDataSource`): the result columns of data
 * contract v1, and the account's privileges (read-only unless a test says otherwise). CI does not run Oracle.
 */
export function databaseFixture(
  pms: SimulatedPms,
  resort: string,
  privileges: {
    system: string[];
    tables: { owner: string; table: string; privilege: string }[];
    roles: string[];
  } = {
    system: ['CREATE SESSION'],
    tables: [
      'RESORT',
      'RESERVATION_NAME',
      'RESERVATION_DAILY_ELEMENT_NAME',
      'RESERVATION_DAILY_ELEMENTS',
      'NAME',
      'NAME_PHONE',
      'ROOM',
      'ROOM_CATEGORY_TEMPLATE',
    ].map((table) => ({ owner: 'OPERA', table, privilege: 'SELECT' })),
    roles: [],
  },
): Record<string, unknown> {
  const all = [...pms.reservations.values()];
  const guests = new Map<string, SimGuest>();
  for (const r of all)
    for (const g of [r.guest, ...r.sharers]) if (g.profileId) guests.set(g.profileId, g);
  return {
    resort,
    reservations: all.map((r) => ({
      RESV_NAME_ID: r.id,
      CONFIRMATION_NO: r.confirmation,
      RESV_STATUS: OPERA_STATUS[r.status],
      ARRIVAL_DATE: r.arrival,
      DEPARTURE_DATE: r.departure,
      ETA:
        r.eta && /T(\d{2}):(\d{2})/.test(r.eta)
          ? r.eta.replace(/^.*T(\d{2}):(\d{2}).*$/, '$1$2')
          : null,
      ADULTS: r.adults,
      CHILDREN: r.children,
      ROOM: r.room ?? null,
      ROOM_CATEGORY: null,
      RATE_CODE: r.rate ?? null,
      MARKET_CODE: r.market ?? null,
      NAME_ID: r.guest.profileId ?? null,
      SHARE_OF: null,
    })),
    names: [...guests.entries()].map(([id, g]) => ({
      NAME_ID: id,
      TITLE: g.title ?? null,
      FIRST: g.first,
      LAST: g.last ?? null,
      LANGUAGE: g.language ?? null,
      VIP_STATUS: g.vip ?? null,
      EMAIL: g.email ?? null,
      PHONE: g.phone ?? null,
    })),
    rooms: roomRows(pms).map((r) => ({
      ROOM: r.room_number,
      ROOM_CATEGORY: r.room_type,
      FLOOR: r.floor,
    })),
    privileges,
  };
}
