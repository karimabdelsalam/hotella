import { z } from 'zod';
import {
  type ConnectorAdapter,
  defineConnector,
  type ParseResult,
  parsedRecords,
  type RawInboundMessage,
  TELEMETRY_BATCH_MESSAGE,
  telemetryBatchPayloadSchema,
} from '@hotella/contracts-connectors';

/**
 * `BMS_STANDARD` — the vendor-neutral building-telemetry connector (ADR-0024, Planova Telemetry Profile v1): a BMS or
 * IoT gateway sends `TELEMETRY_BATCH` messages of raw point samples, through the hotel agent or the signed webhook
 * ingress. Read-only by design: no command ever reaches a building system from here. A vendor gateway (BACnet,
 * Modbus, MQTT bridge — owner decision Q24) is a later connector producing exactly this message.
 */
export const BMS_STANDARD_MANIFEST = defineConnector({
  code: 'BMS_STANDARD',
  version: 1,
  category: 'BMS',
  entitlement: 'CONNECTOR_BMS',
  description:
    'Building telemetry (Planova Telemetry Profile v1): point samples from a BMS or IoT gateway, read-only.',
  transports: ['AGENT', 'WEBHOOK'],
  readOnly: true,
  capabilities: ['TELEMETRY_READ'],
  messageTypes: [
    {
      code: TELEMETRY_BATCH_MESSAGE,
      description: 'Raw point samples: { samples: [{ point, value, at }] } (1–500 per message).',
      requires: 'TELEMETRY_READ',
    },
  ],
  commands: [],
  configSchema: z.object({
    /** Free text shown to staff, e.g. which gateway or building the instance reads. */
    label: z.string().max(200).optional(),
  }),
  credentialSchema: z.object({}),
});

export const bmsStandardAdapter: ConnectorAdapter = {
  manifest: BMS_STANDARD_MANIFEST,
  parse(message: RawInboundMessage): ParseResult {
    if (message.message_type !== TELEMETRY_BATCH_MESSAGE)
      return { ok: false, error: `unsupported message type ${message.message_type}` };
    const payload = telemetryBatchPayloadSchema.safeParse(message.payload);
    // Issues name paths and rules, never values.
    if (!payload.success)
      return { ok: false, error: z.prettifyError(payload.error).slice(0, 1000) };
    return parsedRecords([{ kind: 'TELEMETRY_SAMPLES', samples: payload.data.samples }]);
  },
};
