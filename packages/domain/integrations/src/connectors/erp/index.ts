import { z } from 'zod';
import {
  type ConnectorAdapter,
  defineConnector,
  type ParseResult,
  type RawInboundMessage,
} from '@hotella/contracts-connectors';

/** An ERP item code (the part's external reference, `eng.part` ↔ `ERP_ITEM`). */
const itemCode = z.string().trim().min(1).max(64);
const unit = z.string().trim().min(1).max(16);

/** `ERP_STOCK` rows: what the ERP holds of an item, per warehouse. */
export const erpStockRowSchema = z.object({
  item_code: itemCode,
  on_hand: z.number().finite().min(0),
  unit,
  warehouse: z.string().max(64).nullable().default(null),
});
export type ErpStockRow = z.infer<typeof erpStockRowSchema>;

/** `REQUISITION_CREATE`: a purchase/stores requisition the platform's approval already allowed. */
export const requisitionPayloadSchema = z
  .object({
    requisition_ref: z.uuid(),
    lines: z
      .array(
        z.object({ item_code: itemCode, quantity: z.number().positive().max(1e6), unit }).strict(),
      )
      .min(1)
      .max(20),
    needed_by: z.iso.date().nullable(),
  })
  .strict();
export type RequisitionPayload = z.infer<typeof requisitionPayloadSchema>;

/**
 * `ERP_STANDARD` — the vendor-neutral ERP connector (ADR-0024, Planova ERP Profile v1, BUILD_PLAN 13.5): over the agent
 * link the platform reads stock (`ERP_STOCK`, link protocol 2) and sends approved requisitions (`REQUISITION_CREATE`).
 * Nothing arrives unasked. A vendor ERP (owner decision Q26) is a later connector answering the same query and command.
 */
export const ERP_STANDARD_MANIFEST = defineConnector({
  code: 'ERP_STANDARD',
  version: 1,
  category: 'ERP',
  entitlement: 'CONNECTOR_ERP',
  description: 'ERP (Planova ERP Profile v1): stock levels of items and approved requisitions.',
  transports: ['AGENT'],
  capabilities: ['STOCK_READ', 'REQUISITION_CREATE'],
  messageTypes: [],
  queries: [
    {
      code: 'ERP_STOCK',
      description: 'Stock on hand of up to 50 items, one row per item and warehouse.',
      requires: 'STOCK_READ',
      params: z.object({ items: z.array(itemCode).min(1).max(50) }).strict(),
      row: erpStockRowSchema,
    },
  ],
  commands: [
    {
      code: 'REQUISITION_CREATE',
      description: 'Create a requisition for the lines (approved by a person in the platform).',
      requires: 'REQUISITION_CREATE',
      payload: requisitionPayloadSchema,
    },
  ],
  configSchema: z.object({ label: z.string().max(200).optional() }),
  credentialSchema: z.object({}),
});

export const erpStandardAdapter: ConnectorAdapter = {
  manifest: ERP_STANDARD_MANIFEST,
  parse(message: RawInboundMessage): ParseResult {
    return { ok: false, error: `unsupported message type ${message.message_type}` };
  },
};
