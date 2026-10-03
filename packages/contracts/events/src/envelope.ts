import { z } from 'zod';

/** Queue a published event is delivered on (Spec §71). Declared on the event definition, not at call sites. */
export const DELIVERY_QUEUES = [
  'critical-operational',
  'guest-realtime',
  'normal',
  'analytics',
  'background-ai',
] as const;
export type DeliveryQueue = (typeof DELIVERY_QUEUES)[number];

/**
 * Event names: `<context>.<entity>.<past_tense_event>` + `.v<N>`; `hotel.*` is reserved for canonical PMS/hotel
 * events produced by the Integration Platform (Spec §51, CLAUDE.md rule 24).
 */
export const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/;

/** Spec §51 envelope. `payload` is refined per event by `defineEvent`. */
export const eventEnvelopeSchema = z.object({
  event_id: z.uuid(),
  event_type: z.string().regex(EVENT_TYPE_RE),
  event_version: z.number().int().min(1),
  tenant_id: z.uuid().nullable(),
  property_id: z.uuid().nullable(),
  /** Producing system or context, e.g. `ops`, `comms`, `integration:OPERA5_FIAS`. */
  source: z.string().min(1).max(128),
  /** Producer-side reference (aggregate id, vendor message id); enables idempotent re-publication. */
  source_reference: z.string().max(256).nullable(),
  occurred_at: z.iso.datetime({ offset: true }),
  received_at: z.iso.datetime({ offset: true }),
  correlation_id: z.string().min(1).max(128).nullable(),
  payload: z.unknown(),
});

export type EventEnvelope<P = unknown> = Omit<z.infer<typeof eventEnvelopeSchema>, 'payload'> & {
  payload: P;
};

export function eventName(type: string, version: number): string {
  return `${type}.v${version}`;
}
