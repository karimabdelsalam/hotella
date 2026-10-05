import { z } from 'zod';
import {
  type ConnectorAdapter,
  defineConnector,
  type ParseResult,
  parsedRecords,
  POS_CHECK_MESSAGE,
  posCheckPayloadSchema,
  type RawInboundMessage,
} from '@hotella/contracts-connectors';

/**
 * `POS_STANDARD` — the vendor-neutral point-of-sale connector (ADR-0024, Planova POS Profile v1, BUILD_PLAN 13.5): a
 * POS bridge sends one `POS_CHECK` per closed check — outlet, room or reservation it was charged to, total, covers and
 * settlement, with the check id as `source_message_id` (a resent check is a duplicate). No item lines, no card data,
 * no names. Read-only: nothing is posted to the POS from here. A vendor POS
 * (owner decision Q26) is a later connector producing exactly this message.
 */
export const POS_STANDARD_MANIFEST = defineConnector({
  code: 'POS_STANDARD',
  version: 1,
  category: 'POS',
  entitlement: 'CONNECTOR_POS',
  description: 'Point of sale (Planova POS Profile v1): closed checks with totals, read-only.',
  transports: ['AGENT', 'WEBHOOK'],
  readOnly: true,
  capabilities: ['CHECK_READ'],
  messageTypes: [
    {
      code: POS_CHECK_MESSAGE,
      description:
        'A closed check: { check_id, outlet, room?, reservation?, closed_at, total_minor, currency, covers?, settlement }.',
      requires: 'CHECK_READ',
    },
  ],
  commands: [],
  configSchema: z.object({
    /** Free text shown to staff, e.g. which POS system the instance reads. */
    label: z.string().max(200).optional(),
  }),
  credentialSchema: z.object({}),
});

export const posStandardAdapter: ConnectorAdapter = {
  manifest: POS_STANDARD_MANIFEST,
  parse(message: RawInboundMessage): ParseResult {
    if (message.message_type !== POS_CHECK_MESSAGE)
      return { ok: false, error: `unsupported message type ${message.message_type}` };
    const payload = posCheckPayloadSchema.safeParse(message.payload);
    // Issues name paths and rules, never values.
    if (!payload.success)
      return { ok: false, error: z.prettifyError(payload.error).slice(0, 1000) };
    const p = payload.data;
    // One message per check: its id is the message id, so a resent check is the same message (dedupe at ingest).
    if (message.source_message_id !== p.check_id)
      return { ok: false, error: 'source_message_id must be the check id' };
    return parsedRecords([
      {
        kind: 'POS_CHECK_CLOSED',
        check: { external_id: p.check_id },
        outlet_code: p.outlet,
        room_code: p.room,
        reservation: p.reservation,
        total_minor: p.total_minor,
        currency: p.currency,
        covers: p.covers,
        settlement: p.settlement,
        occurred_at: p.closed_at,
      },
    ]);
  },
};
