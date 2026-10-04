import { type ConnectorQuery, pmsQueryParams, pmsQueryRows } from '@hotella/contracts-connectors';

/** The standard PMS read queries (guide §4.2) as a connector declares them. */
export function pmsQueries(
  requires: Partial<Record<keyof typeof pmsQueryParams, ConnectorQuery['requires']>>,
): ConnectorQuery[] {
  const description: Record<keyof typeof pmsQueryParams, string> = {
    LOOKUP_RESERVATION: 'One reservation by confirmation number or reservation id.',
    LIST_ARRIVALS: 'Reservations arriving in a date window (at most 31 days).',
    IN_HOUSE: 'Reservations in house now (also the reconciliation snapshot).',
    LOOKUP_PROFILE: 'One guest profile (contract fields only).',
    ROOM_INVENTORY: 'Rooms of the property with type and floor.',
  };
  return (Object.keys(requires) as Array<keyof typeof pmsQueryParams>).map((code) => ({
    code,
    description: description[code],
    requires: requires[code]!,
    params: pmsQueryParams[code],
    row: pmsQueryRows[code],
  }));
}
