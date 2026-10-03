import { z } from 'zod';
import { CONNECTOR_CAPABILITIES } from './capabilities';

/**
 * Hotel-agent link protocol v1 (ADR-0017 §3–§5). JSON frames over one WebSocket (`/agent/v1/link`, mutual TLS) plus
 * HTTPS batches for resyncs (`/agent/v1/batches`). The agent always connects out; the platform never connects in.
 *
 * Reliability rules:
 * - every inbound message carries a per-instance, strictly increasing `sequence_no`; the platform acknowledges
 *   cumulatively (`ack` = everything up to and including this number is durable) and the agent deletes only then;
 * - a gap makes the platform ask for a resend from the first missing number; a repeat is acknowledged again;
 * - commands are predefined operation codes from the connector manifest, Ed25519-signed by the platform, idempotent
 *   by `command_id`, and answered with `command_result`.
 */

export const LINK_PROTOCOL_VERSION = 1;
export const LINK_PATH = '/agent/v1/link';
export const BATCH_PATH = '/agent/v1/batches';
export const ENROLL_PATH = '/agent/v1/enroll';
export const RENEW_PATH = '/agent/v1/renew';
/** Batches are bounded (ADR-0017 §3: ≤ 5 MB, gzip allowed). */
export const MAX_BATCH_MESSAGES = 500;

const instant = z.iso.datetime({ offset: true });
const sequence = z.number().int().min(1);

/** One raw vendor message, as forwarded from the agent's durable queue. */
export const linkMessageSchema = z.object({
  type: z.literal('message'),
  sequence_no: sequence,
  source_message_id: z.string().min(1).max(200),
  message_type: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  occurred_at: instant.nullable().default(null),
  payload: z.unknown(),
});
export type LinkMessage = z.infer<typeof linkMessageSchema>;

// ---- agent → platform ----

export const agentFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocol: z.literal(LINK_PROTOCOL_VERSION),
    agent_version: z.string().min(1).max(64),
    connector_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,47}$/),
    /** What this agent can serve at this hotel (becomes the instance's reported capabilities). */
    capabilities: z.array(z.enum(CONNECTOR_CAPABILITIES)).max(64),
    /** Oldest sequence still in the agent's durable queue; null when the queue is empty. */
    first_buffered_sequence: sequence.nullable(),
  }),
  linkMessageSchema,
  z.object({
    type: z.literal('heartbeat'),
    sent_at: instant,
    /** Messages waiting in the agent's local queue. */
    queue_depth: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('command_result'),
    command_id: z.uuid(),
    status: z.enum(['ACKNOWLEDGED', 'FAILED']),
    error: z.string().max(1000).nullable().default(null),
  }),
]);
export type AgentFrame = z.infer<typeof agentFrameSchema>;
export type AgentFrameInput = z.input<typeof agentFrameSchema>;

// ---- platform → agent ----

export const commandFrameBodySchema = z.object({
  type: z.literal('command'),
  command_id: z.uuid(),
  instance_id: z.uuid(),
  command_type: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(200),
  issued_at: instant,
  expires_at: instant.nullable(),
});
export type CommandFrameBody = z.infer<typeof commandFrameBodySchema>;

export const platformFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    session_id: z.uuid(),
    instance_id: z.uuid(),
    /** The next sequence number the platform expects (everything before it is durable on the platform). */
    next_expected_sequence: sequence,
    heartbeat_interval_seconds: z.number().int().min(5).max(300),
    server_time: instant,
  }),
  z.object({ type: z.literal('ack'), sequence_no: z.number().int().min(0) }),
  z.object({ type: z.literal('resend'), from_sequence: sequence }),
  z.object({ type: z.literal('throttle'), max_messages_per_second: z.number().int().min(1) }),
  commandFrameBodySchema.extend({
    /** Ed25519 over the canonical JSON of the frame without this field (verified against the pinned key). */
    signature: z.string().min(16),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1).max(64),
    message: z.string().max(500),
  }),
]);
export type PlatformFrame = z.infer<typeof platformFrameSchema>;

// ---- HTTPS ----

export const enrollRequestSchema = z.object({
  token: z.string().min(20).max(200),
  csr: z.string().min(100).max(20_000),
  agent_version: z.string().min(1).max(64),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export const enrollResponseSchema = z.object({
  instance_id: z.uuid(),
  certificate: z.string(),
  ca_certificate: z.string(),
  not_after: instant,
  /** Ed25519 public key (SPKI PEM) the agent pins to verify command signatures. */
  command_signing_public_key: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

export const renewRequestSchema = z.object({ csr: z.string().min(100).max(20_000) });

export const batchRequestSchema = z.object({
  messages: z.array(linkMessageSchema).min(1).max(MAX_BATCH_MESSAGES),
});
export type BatchRequest = z.infer<typeof batchRequestSchema>;

export const batchResponseSchema = z.object({
  /** Highest sequence durable on the platform after this batch. */
  acked_through: z.number().int().min(0),
  /** Set when a gap stopped processing: resend from here. */
  resend_from: sequence.nullable(),
});
export type BatchResponse = z.infer<typeof batchResponseSchema>;
