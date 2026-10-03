import { z } from 'zod';
import {
  type ConnectorAdapter,
  defineConnector,
  type ParseContext,
  type ParseResult,
  parsedRecords,
  type RawInboundMessage,
} from '@hotella/contracts-connectors';
import { parseFiasRecord } from './fias';
import { parseOwsProfile, parseOwsReservation } from './ows';

/**
 * `SIM_PMS` — the PMS simulator connector (BUILD_PLAN §6.3). Two faces so capability negotiation is exercised long
 * before OPERA (ADR-0014): a FIAS-shaped event stream (in-house events only) and an OWS-shaped query face (future
 * reservations, profiles, ETA). An instance enables either or both through its capabilities.
 */
export const SIM_PMS_MANIFEST = defineConnector({
  code: 'SIM_PMS',
  version: 1,
  category: 'PMS',
  description:
    'PMS simulator (FIAS-shaped event stream and OWS-shaped query face) for development and CI.',
  capabilities: [
    'CHECKIN_EVENT',
    'CHECKOUT_EVENT',
    'ROOM_MOVE_EVENT',
    'PROFILE_EVENT',
    'ROOM_STATUS_READ',
    'RESERVATION_READ',
    'GUEST_READ',
    'RECONCILIATION_READ',
  ],
  messageTypes: [
    {
      code: 'FIAS_RECORD',
      description: 'One FIAS-shaped record: { record: "GI|RN504|G#…|" }.',
      requires: 'CHECKIN_EVENT',
    },
    {
      code: 'OWS_RESERVATION',
      description: 'An OWS-shaped reservation result (NEW, CHANGE, CANCEL, NOSHOW).',
      requires: 'RESERVATION_READ',
    },
    {
      code: 'OWS_PROFILE',
      description: 'An OWS-shaped guest profile result.',
      requires: 'GUEST_READ',
    },
  ],
  commands: [],
  configSchema: z.object({
    /** Free text shown to staff, e.g. which simulator container serves the instance. */
    label: z.string().max(200).optional(),
  }),
  credentialSchema: z.object({}),
});

const fiasMessage = z.object({ record: z.string().min(2).max(4000) });

export const simPmsAdapter: ConnectorAdapter = {
  manifest: SIM_PMS_MANIFEST,
  parse(message: RawInboundMessage, context: ParseContext): ParseResult {
    try {
      switch (message.message_type) {
        case 'FIAS_RECORD':
          return parsedRecords(parseFiasRecord(fiasMessage.parse(message.payload).record, context));
        case 'OWS_RESERVATION':
          return parsedRecords(parseOwsReservation(message.payload));
        case 'OWS_PROFILE':
          return parsedRecords(parseOwsProfile(message.payload));
        default:
          return { ok: false, error: `unsupported message type ${message.message_type}` };
      }
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
