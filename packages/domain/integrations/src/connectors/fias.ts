import { type InboundRecordInput, localDateTimeToUtc } from '@hotella/contracts-connectors';

/**
 * FIAS record parsing, shared by `OPERA5_FIAS` (the hotel agent's IFC8 link) and the simulator's FIAS-shaped face
 * (ADR-0014). A record is a two-letter record id followed by `|`-separated fields, each a two-character field id and
 * its value, e.g. `GI|RN504|G#10001|GNSmith|GFJane|GLen|GA261003|GD261006|DA261003|TI140500|`.
 *
 * Only in-house events exist (FIAS knows no future reservations). Times are hotel wall-clock (DA/TI) and converted
 * with the property timezone. A database sync is DS … DE around the in-house list: OPERA sends each stay as a `GI`
 * carrying the sync flag `SF`, the simulator as `DR`; both are snapshot entries for reconciliation, never check-ins
 * (a difference is a person's decision, not a silent fix).
 */

export type FiasFields = ReadonlyMap<string, string>;

export class FiasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiasParseError';
  }
}

export function splitFiasRecord(record: string): { id: string; fields: FiasFields } {
  const parts = record.trim().split('|');
  const id = parts.shift() ?? '';
  if (!/^[A-Z]{2}$/.test(id)) throw new FiasParseError('record id must be two upper-case letters');
  const fields = new Map<string, string>();
  for (const part of parts) {
    if (part.length === 0) continue;
    if (part.length < 2) throw new FiasParseError('malformed field');
    fields.set(part.slice(0, 2), part.slice(2));
  }
  return { id, fields };
}

/** YYMMDD → ISO date (FIAS years are two-digit; 20YY). */
function fiasDate(value: string | undefined, field: string): string {
  if (!value || !/^\d{6}$/.test(value)) throw new FiasParseError(`${field} must be YYMMDD`);
  const iso = `20${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`)))
    throw new FiasParseError(`${field} is not a date`);
  return iso;
}

function fiasInstant(fields: FiasFields, timezone: string, fallback: string): string {
  const da = fields.get('DA');
  if (!da) return fallback;
  const date = fiasDate(da, 'DA');
  const ti = fields.get('TI') ?? '000000';
  if (!/^\d{6}$/.test(ti)) throw new FiasParseError('TI must be HHMMSS');
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return localDateTimeToUtc(
    {
      year,
      month,
      day,
      hour: Number(ti.slice(0, 2)),
      minute: Number(ti.slice(2, 4)),
      second: Number(ti.slice(4, 6)),
    },
    timezone,
  ).toISOString();
}

function required(fields: FiasFields, key: string, label: string): string {
  const v = fields.get(key)?.trim();
  if (!v) throw new FiasParseError(`${label} (${key}) is required`);
  return v;
}

function profile(fields: FiasFields) {
  const family = fields.get('GN')?.trim() || null;
  const given = fields.get('GF')?.trim() || null;
  const lang = fields.get('GL')?.trim().toLowerCase();
  return {
    // FIAS has no stable profile id on GI/GC; the guest is identified through the reservation.
    external_id: null,
    given_name: given ?? family ?? required(fields, 'GN', 'guest name'),
    family_name: given ? family : null,
    title: fields.get('GT')?.trim() || null,
    locale: lang && /^[a-z]{2}$/.test(lang) ? lang : null,
    vip_code: fields.get('GV')?.trim() || null,
  };
}

/** FIAS `RS` maid status: 1 dirty/vacant · 2 dirty/occupied · 3 clean/vacant · 4 clean/occupied · 5/6 inspected. */
const ROOM_STATUS: Record<string, { status: 'DIRTY' | 'CLEAN' | 'INSPECTED'; occupied: boolean }> =
  {
    '1': { status: 'DIRTY', occupied: false },
    '2': { status: 'DIRTY', occupied: true },
    '3': { status: 'CLEAN', occupied: false },
    '4': { status: 'CLEAN', occupied: true },
    '5': { status: 'INSPECTED', occupied: false },
    '6': { status: 'INSPECTED', occupied: true },
  };

/** Link-control records: accepted, produce no business record. */
const CONTROL_RECORDS = new Set(['LS', 'LA', 'LE', 'LD', 'LR']);
/**
 * Night audit start/end (optional records of the standard profile, requested only when the hotel enables them):
 * accepted and counted in the profile coverage; the business date is the property's local date, so they change nothing.
 */
const NIGHT_AUDIT_RECORDS = new Set(['NS', 'NE']);

/** The record id and field ids of a FIAS record, without interpreting values (profile coverage, guide §7.3). */
export function fiasObservation(record: string): { record: string; fields: string[] } | null {
  try {
    const { id, fields } = splitFiasRecord(record);
    return CONTROL_RECORDS.has(id) ? null : { record: id, fields: [...fields.keys()] };
  } catch {
    return null;
  }
}

export function parseFiasRecord(
  record: string,
  context: { readonly timezone: string; readonly receivedAt: string },
): InboundRecordInput[] {
  const { id, fields } = splitFiasRecord(record);
  if (CONTROL_RECORDS.has(id) || NIGHT_AUDIT_RECORDS.has(id)) return [];
  const at = fiasInstant(fields, context.timezone, context.receivedAt);
  switch (id) {
    case 'GI': {
      if (fields.has('SF'))
        return [
          {
            kind: 'IN_HOUSE_ENTRY',
            reservation: { external_id: required(fields, 'G#', 'reservation number') },
            room_code: fields.get('RN')?.trim() || null,
            occurred_at: at,
          },
        ];
      const arrival = fields.get('GA') ? fiasDate(fields.get('GA'), 'GA') : at.slice(0, 10);
      return [
        {
          kind: 'CHECK_IN',
          reservation: { external_id: required(fields, 'G#', 'reservation number') },
          primary_guest: profile(fields),
          arrival_date: arrival,
          departure_date: fiasDate(fields.get('GD'), 'GD'),
          room_code: required(fields, 'RN', 'room number'),
          occurred_at: at,
        },
      ];
    }
    // Database sync: DS (start) / DR (one in-house reservation) / DE (end) — a snapshot for reconciliation.
    case 'DS':
      return [{ kind: 'SYNC_START', occurred_at: at }];
    case 'DR':
      return [
        {
          kind: 'IN_HOUSE_ENTRY',
          reservation: { external_id: required(fields, 'G#', 'reservation number') },
          room_code: fields.get('RN')?.trim() || null,
          occurred_at: at,
        },
      ];
    case 'DE':
      return [{ kind: 'SYNC_END', occurred_at: at }];
    case 'GO':
      return [
        {
          kind: 'CHECK_OUT',
          reservation: { external_id: required(fields, 'G#', 'reservation number') },
          room_code: fields.get('RN')?.trim() || null,
          occurred_at: at,
        },
      ];
    case 'GC': {
      const reservation = { external_id: required(fields, 'G#', 'reservation number') };
      const out: InboundRecordInput[] = [];
      const room = fields.get('RN')?.trim();
      const oldRoom = fields.get('RO')?.trim();
      if (oldRoom && room && oldRoom !== room) {
        out.push({
          kind: 'ROOM_MOVE',
          reservation,
          from_room_code: oldRoom,
          to_room_code: room,
          occurred_at: at,
        });
      }
      if (['GN', 'GF', 'GL', 'GV', 'GT'].some((k) => fields.has(k))) {
        out.push({
          kind: 'PROFILE_UPDATE',
          reservation,
          profile: profile(fields),
          occurred_at: at,
        });
      }
      if (out.length === 0)
        throw new FiasParseError('GC carries neither a room move nor profile data');
      return out;
    }
    case 'RE': {
      const rs = required(fields, 'RS', 'room status');
      const mapped = ROOM_STATUS[rs];
      if (!mapped) throw new FiasParseError(`unsupported RS value`);
      return [
        {
          kind: 'ROOM_STATUS',
          room_code: required(fields, 'RN', 'room number'),
          status: mapped.status,
          occupied: mapped.occupied,
          occurred_at: at,
        },
      ];
    }
    default:
      throw new FiasParseError(`unsupported record ${id}`);
  }
}
