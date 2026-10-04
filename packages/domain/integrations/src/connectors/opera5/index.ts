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
