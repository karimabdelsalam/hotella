import { z, type ZodType } from 'zod';
import {
  CONNECTOR_CATEGORIES,
  type ConnectorCapability,
  type ConnectorCategory,
  isConnectorCapability,
  isWriteCapability,
} from './capabilities';
import type { InterfaceProfile, ProfileObservation } from './profiles';
import { type InboundRecord, inboundRecordSchema } from './records';

export const CONNECTOR_CODE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const MESSAGE_TYPE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A kind of raw message the connector accepts, and the capability an instance must have negotiated to accept it. */
export interface ConnectorMessageType {
  readonly code: string;
  readonly description: string;
  readonly requires: ConnectorCapability;
}

/** A predefined outbound operation (Spec §48, §53; ADR-0017 §1: no generic remote execution). */
export interface ConnectorCommand<P extends ZodType = ZodType> {
  readonly code: string;
  readonly description: string;
  readonly requires: ConnectorCapability;
  readonly payload: P;
}

/**
 * A predefined read (link protocol 2, ADR-0019): the agent runs only query types compiled into it, with these
 * parameters, and answers rows of this schema.
 */
export interface ConnectorQuery {
  readonly code: string;
  readonly description: string;
  readonly requires: ConnectorCapability;
  readonly params: ZodType;
  readonly row: ZodType;
}

/** Connector manifest (Spec §56): what the connector type is and can do. One per connector code and version. */
export interface ConnectorManifest {
  readonly code: string;
  readonly version: number;
  readonly category: ConnectorCategory;
  readonly description: string;
  readonly capabilities: readonly ConnectorCapability[];
  readonly messageTypes: readonly ConnectorMessageType[];
  readonly commands: readonly ConnectorCommand[];
  /** Predefined reads served over link protocol 2; absent = none. */
  readonly queries?: readonly ConnectorQuery[];
  /** Non-secret instance configuration (validated on instance create/update). */
  readonly configSchema: ZodType;
  /**
   * Credential *references* the instance needs (each value is a SecretRef such as `vault://…`); secret material is
   * never stored by the platform (CLAUDE.md rule 13). Agent-side credentials (OPERA interface passwords) never reach
   * the platform at all (ADR-0017 §5).
   */
  readonly credentialSchema: ZodType;
  /**
   * The licensing entitlement a tenant needs to run this connector (Spec §59), e.g. `CONNECTOR_OPERA5`; the agent's
   * offline licence is issued only while it is entitled (Spec §62).
   */
  readonly entitlement?: string;
  /**
   * A read-only connector (the OPERA database, ADR-0019): it may declare no write capability and no command, so no
   * write can ever be routed to it — a definition error, not a convention.
   */
  readonly readOnly?: boolean;
  /**
   * The interface profile the connector expects from the PMS (e.g. the Planova Standard FIAS Profile, guide §7.3);
   * received messages are compared with it and what a hotel does not deliver is reported as a profile gap.
   */
  readonly profile?: InterfaceProfile;
}

export class ConnectorDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorDefinitionError';
  }
}

/** Validates a manifest at definition time so a malformed connector fails tests, not production. */
export function defineConnector(manifest: ConnectorManifest): ConnectorManifest {
  const fail = (m: string): never => {
    throw new ConnectorDefinitionError(`Connector ${manifest.code}: ${m}`);
  };
  if (!CONNECTOR_CODE_RE.test(manifest.code)) fail('code must be UPPER_SNAKE_CASE');
  if (!Number.isInteger(manifest.version) || manifest.version < 1)
    fail('version must be a positive integer');
  if (!CONNECTOR_CATEGORIES.includes(manifest.category)) fail(`unknown category`);
  if (manifest.entitlement !== undefined && !CONNECTOR_CODE_RE.test(manifest.entitlement))
    fail('entitlement must be UPPER_SNAKE_CASE');
  const caps = new Set<string>(manifest.capabilities);
  for (const c of manifest.capabilities) {
    if (!isConnectorCapability(c)) fail(`unknown capability ${c}`);
    if (manifest.readOnly && isWriteCapability(c)) fail(`is read-only and cannot declare ${c}`);
  }
  if (manifest.readOnly && manifest.commands.length > 0)
    fail('is read-only and cannot declare commands');
  for (const [id, r] of Object.entries(manifest.profile?.records ?? {})) {
    if (!/^[A-Z0-9]{2}$/.test(id)) fail(`profile record ${id} must be a two-character id`);
    if (new Set(r.fields).size !== r.fields.length) fail(`profile record ${id} repeats a field`);
    for (const f of r.mandatory)
      if (!r.fields.includes(f)) fail(`profile record ${id} requires unrequested field ${f}`);
  }
  const seen = new Set<string>();
  for (const m of manifest.messageTypes) {
    if (!MESSAGE_TYPE_RE.test(m.code)) fail(`message type ${m.code} must be UPPER_SNAKE_CASE`);
    if (seen.has(m.code)) fail(`duplicate message type ${m.code}`);
    seen.add(m.code);
    if (!caps.has(m.requires)) fail(`message type ${m.code} requires undeclared ${m.requires}`);
  }
  for (const c of manifest.commands) {
    if (!MESSAGE_TYPE_RE.test(c.code)) fail(`command ${c.code} must be UPPER_SNAKE_CASE`);
    if (!caps.has(c.requires)) fail(`command ${c.code} requires undeclared ${c.requires}`);
  }
  const queries = new Set<string>();
  for (const q of manifest.queries ?? []) {
    if (!MESSAGE_TYPE_RE.test(q.code)) fail(`query ${q.code} must be UPPER_SNAKE_CASE`);
    if (queries.has(q.code)) fail(`duplicate query ${q.code}`);
    queries.add(q.code);
    if (!caps.has(q.requires)) fail(`query ${q.code} requires undeclared ${q.requires}`);
    if (isWriteCapability(q.requires))
      fail(`query ${q.code} cannot require the write ${q.requires}`);
  }
  return Object.freeze({ ...manifest });
}

/** One raw vendor message as received from an agent or a webhook, before any interpretation (Spec §50). */
export const rawInboundMessageSchema = z.object({
  message_type: z.string().regex(MESSAGE_TYPE_RE),
  /** Source-side unique id; the platform inbox is keyed by (instance, source_message_id) — replays are no-ops. */
  source_message_id: z.string().min(1).max(200),
  /** Per-instance monotonically increasing sequence from the agent link (ADR-0017 §4); null for webhooks. */
  sequence_no: z.number().int().min(0).nullable().default(null),
  /** When the source produced the message, if known. */
  occurred_at: z.iso.datetime({ offset: true }).nullable().default(null),
  payload: z.unknown(),
});
export type RawInboundMessage = z.infer<typeof rawInboundMessageSchema>;
export type RawInboundMessageInput = z.input<typeof rawInboundMessageSchema>;

export type ParseResult =
  | { readonly ok: true; readonly records: readonly InboundRecord[] }
  | { readonly ok: false; readonly error: string };

/** What an adapter may know besides the message itself (kept minimal so parsing stays pure and replayable). */
export interface ParseContext {
  /** IANA timezone of the property; sources such as FIAS report local wall-clock times. */
  readonly timezone: string;
  /** When the platform received the message (ISO 8601), the fallback for records without their own time. */
  readonly receivedAt: string;
}

/**
 * A connector adapter on the platform side: turns raw vendor messages into connector-neutral records. Pure and
 * deterministic (no I/O, no clock other than message data), so parsing can be replayed at any time.
 */
export interface ConnectorAdapter {
  readonly manifest: ConnectorManifest;
  parse(message: RawInboundMessage, context: ParseContext): ParseResult;
  /**
   * For connectors with a `profile`: the record id and field ids a message carried, read without interpreting it (so
   * a record the parser refuses is still counted). Pure; null when the message is not a profile record.
   */
  observe?(message: RawInboundMessage): ProfileObservation | null;
}

/** Helper for adapters: validate produced records against the SDK contract (a malformed record is a parse error). */
export function parsedRecords(records: readonly unknown[]): ParseResult {
  const out: InboundRecord[] = [];
  for (const r of records) {
    const parsed = inboundRecordSchema.safeParse(r);
    if (!parsed.success)
      return { ok: false, error: `invalid record: ${z.prettifyError(parsed.error)}` };
    out.push(parsed.data);
  }
  return { ok: true, records: out };
}
