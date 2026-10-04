import { z } from 'zod';
import {
  type ConnectorAdapter,
  defineConnector,
  type ParseContext,
  type ParseResult,
  parsedRecords,
  type RawInboundMessage,
} from '@hotella/contracts-connectors';
import { parseFiasRecord } from '../fias';
import { pmsQueries } from '../pms-queries';
import { parseOwsProfile, parseOwsReservation } from '../ows';

/**
 * `OPERA5_FIAS` — OPERA 5 through its IFC8 FIAS interface (ADR-0014, BUILD_PLAN §10 Phase 10): the primary, real-time
 * link. The hotel agent holds the IFC8 TCP session (link start/description/records/alive, database sync) and forwards
 * every business record as received; this adapter turns them into canonical records. FIAS carries in-house events
 * only; future reservations and profiles come from `OPERA5_OWS` where the hotel has it.
 */
export const OPERA5_FIAS_MANIFEST = defineConnector({
  code: 'OPERA5_FIAS',
  version: 1,
  category: 'PMS',
  entitlement: 'CONNECTOR_OPERA5',
  description:
    'OPERA 5 via the IFC8 FIAS interface: check-in, check-out, room moves, guest changes and room status in real time; database sync for reconciliation.',
  capabilities: [
    'CHECKIN_EVENT',
    'CHECKOUT_EVENT',
    'ROOM_MOVE_EVENT',
    'PROFILE_EVENT',
    'ROOM_STATUS_READ',
    'ROOM_STATUS_WRITE',
    'RECONCILIATION_READ',
  ],
  messageTypes: [
    {
      code: 'FIAS_RECORD',
      description: 'One FIAS record as received from IFC8: { record: "GI|RN504|G#…|" }.',
      requires: 'CHECKIN_EVENT',
    },
  ],
  commands: [
    {
      code: 'RESYNC_IN_HOUSE',
      description:
        'Ask IFC8 for a database sync (FIAS DR); OPERA answers DS, the in-house list and DE, used by reconciliation.',
      requires: 'RECONCILIATION_READ',
      payload: z.object({}).strict(),
    },
    {
      code: 'SET_ROOM_STATUS',
      description:
        "Write a room's housekeeping status to OPERA (FIAS RE from the interface). Enabled per hotel only after it is verified at the pilot.",
      requires: 'ROOM_STATUS_WRITE',
      payload: z
        .object({
          room_number: z.string().min(1).max(16),
          status: z.enum(['DIRTY', 'CLEAN', 'INSPECTED']),
          /** FIAS room status codes carry occupancy (RS 1–6); the agent refuses the write without it. */
          occupied: z.boolean().optional(),
        })
        .strict(),
    },
  ],
  configSchema: z.object({
    /** Where the agent reaches IFC8, for staff and support (the agent's own settings hold the real address). */
    label: z.string().max(200).optional(),
  }),
  // FIAS over TCP has no credentials; the link to IFC8 stays inside the hotel's network.
  credentialSchema: z.object({}),
});

const fiasMessage = z.object({ record: z.string().min(2).max(4000) });

export const opera5FiasAdapter: ConnectorAdapter = {
  manifest: OPERA5_FIAS_MANIFEST,
  parse(message: RawInboundMessage, context: ParseContext): ParseResult {
    try {
      if (message.message_type !== 'FIAS_RECORD')
        return { ok: false, error: `unsupported message type ${message.message_type}` };
      return parsedRecords(parseFiasRecord(fiasMessage.parse(message.payload).record, context));
    } catch (err) {
      // Zod issues name paths and rules, never values, so the error stays free of guest data.
      const error =
        err instanceof z.ZodError
          ? z.prettifyError(err)
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, error: error.slice(0, 1000) };
    }
  },
};

/**
 * `OPERA5_OWS` — OPERA Web Services, where the hotel has them licensed (ADR-0014): what FIAS cannot give — future
 * reservations, arrivals with ETA, sharers and profiles — for pre-arrival and arrival risk. The agent polls OWS over
 * SOAP for a window of arrivals and forwards each reservation that changed; nothing is written to OPERA through OWS.
 */
export const OPERA5_OWS_MANIFEST = defineConnector({
  code: 'OPERA5_OWS',
  version: 1,
  category: 'PMS',
  entitlement: 'CONNECTOR_OPERA5',
  description:
    'OPERA 5 via OPERA Web Services (OWS): future reservations, arrivals with ETA, sharers and guest profiles, polled by the hotel agent.',
  capabilities: ['RESERVATION_READ', 'GUEST_READ', 'PROFILE_EVENT'],
  messageTypes: [
    {
      code: 'OWS_RESERVATION',
      description: 'A reservation that changed in the polled window (NEW, CHANGE, CANCEL, NOSHOW).',
      requires: 'RESERVATION_READ',
    },
    {
      code: 'OWS_PROFILE',
      description: 'A guest profile that changed.',
      requires: 'GUEST_READ',
    },
  ],
  commands: [],
  configSchema: z.object({
    label: z.string().max(200).optional(),
  }),
  // The OWS user and password stay at the hotel, in the agent's protected store; the platform never holds them.
  credentialSchema: z.object({}),
});

export const opera5OwsAdapter: ConnectorAdapter = {
  manifest: OPERA5_OWS_MANIFEST,
  parse(message: RawInboundMessage): ParseResult {
    try {
      switch (message.message_type) {
        case 'OWS_RESERVATION':
          return parsedRecords(parseOwsReservation(message.payload));
        case 'OWS_PROFILE':
          return parsedRecords(parseOwsProfile(message.payload));
        default:
          return { ok: false, error: `unsupported message type ${message.message_type}` };
      }
    } catch (err) {
      const error =
        err instanceof z.ZodError
          ? z.prettifyError(err)
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, error: error.slice(0, 1000) };
    }
  },
};

/**
 * `OPERA5_DB` — OPERA 5 read through a dedicated, SELECT-only Oracle account (ADR-0019; guide §6): lookups, lists,
 * room inventory and the reconciliation snapshot, answered over link protocol 2 by predefined statements compiled into
 * the agent, plus fallback change polling in the arrival window when OWS is absent. Read-only by definition: it can
 * declare no write capability and no command, and routing never sends a write to it.
 */
export const OPERA5_DB_MANIFEST = defineConnector({
  code: 'OPERA5_DB',
  version: 1,
  category: 'PMS',
  entitlement: 'CONNECTOR_OPERA5',
  readOnly: true,
  description:
    'OPERA 5 read-only database access (SELECT-only account, data contract v1): reservation and profile lookups, arrivals, in-house snapshot, room inventory; never written.',
  capabilities: [
    'RESERVATION_READ',
    'RESERVATION_LOOKUP',
    'ARRIVALS_READ',
    'IN_HOUSE_SNAPSHOT',
    'GUEST_READ',
    'PROFILE_LOOKUP',
    'ROOM_INVENTORY_READ',
    'RECONCILIATION_READ',
  ],
  messageTypes: [
    {
      code: 'OPERA_DB_RESERVATION',
      description:
        'A reservation that changed in the polled arrival window (fallback change polling when OWS is absent), in the OWS reservation shape.',
      requires: 'RESERVATION_READ',
    },
  ],
  commands: [],
  queries: pmsQueries({
    LOOKUP_RESERVATION: 'RESERVATION_LOOKUP',
    LIST_ARRIVALS: 'ARRIVALS_READ',
    IN_HOUSE: 'IN_HOUSE_SNAPSHOT',
    LOOKUP_PROFILE: 'PROFILE_LOOKUP',
    ROOM_INVENTORY: 'ROOM_INVENTORY_READ',
  }),
  configSchema: z.object({
    label: z.string().max(200).optional(),
  }),
  // The Oracle account and its password stay at the hotel, in the agent's protected store.
  credentialSchema: z.object({}),
});

export const opera5DbAdapter: ConnectorAdapter = {
  manifest: OPERA5_DB_MANIFEST,
  parse(message: RawInboundMessage): ParseResult {
    try {
      if (message.message_type !== 'OPERA_DB_RESERVATION')
        return { ok: false, error: `unsupported message type ${message.message_type}` };
      return parsedRecords(parseOwsReservation(message.payload));
    } catch (err) {
      const error =
        err instanceof z.ZodError
          ? z.prettifyError(err)
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, error: error.slice(0, 1000) };
    }
  },
};
