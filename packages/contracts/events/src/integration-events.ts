import { z } from 'zod';
import { defineEvent } from './registry';

/** Integration Platform events (Spec §52, §57). Never carry raw vendor payloads or guest data. */

export const IntegrationExceptionOpened = defineEvent({
  type: 'integration.exception.opened',
  version: 1,
  description:
    'A new integration exception needs a human (unknown code, unparseable or unsupported message, conflict). Deduplicated: repeats of an open unknown code do not re-publish.',
  payload: z.object({
    exception_id: z.uuid(),
    instance_id: z.uuid(),
    kind: z.enum(['UNKNOWN_MAPPING', 'PARSE_ERROR', 'UNSUPPORTED_MESSAGE', 'CONFLICT']),
    mapping_type: z.string().nullable(),
    external_code: z.string().nullable(),
  }),
});

export const IntegrationHealthChanged = defineEvent({
  type: 'integration.health.changed',
  version: 1,
  description:
    'The health state of an integration instance changed (Spec §57); alerting deduplicates on (instance, status).',
  payload: z.object({
    instance_id: z.uuid(),
    from: z.enum(['HEALTHY', 'DEGRADED', 'OFFLINE', 'MISCONFIGURED', 'AUTH_FAILED']),
    to: z.enum(['HEALTHY', 'DEGRADED', 'OFFLINE', 'MISCONFIGURED', 'AUTH_FAILED']),
  }),
});

export const ReconciliationSnapshotCompleted = defineEvent({
  type: 'integration.reconciliation.snapshot_completed',
  version: 1,
  description:
    'The PMS finished reporting its in-house list for a reconciliation run; the stay owner compares and reports results back (Spec §52).',
  payload: z.object({
    run_id: z.uuid(),
    instance_id: z.uuid(),
    entries: z.number().int().min(0),
  }),
});

export const ReconciliationCompleted = defineEvent({
  type: 'integration.reconciliation.completed',
  version: 1,
  description: 'A reconciliation run finished; non-matching results opened integration exceptions.',
  payload: z.object({
    run_id: z.uuid(),
    instance_id: z.uuid(),
    summary: z.record(z.string(), z.number().int()),
  }),
});

export const IntegrationCapabilityChanged = defineEvent({
  type: 'integration.capability.changed',
  version: 1,
  description:
    "A property's effective PMS capability changed (ADR-0019 registry): verification, enablement, licence or connector health. Apps and AI tools re-read what they may offer.",
  payload: z.object({
    capability: z.string(),
    effective: z.boolean(),
    /** Connector codes that serve it now. */
    connectors: z.array(z.string()),
  }),
});

/**
 * Building telemetry (Planova Telemetry Profile v1, BUILD_PLAN 13.2): the connector-neutral samples of one message,
 * one event per message (never per sample). Point codes are still external: engineering resolves them against its
 * point registry and reports unknown ones back as integration exceptions (rule 16).
 */
export const IntegrationTelemetryReceived = defineEvent({
  type: 'integration.telemetry_batch.received',
  version: 1,
  description:
    'A batch of telemetry samples arrived from a BMS/IoT integration; engineering keeps minute aggregates and evaluates its rules.',
  payload: z.object({
    instance_id: z.uuid(),
    message_id: z.uuid(),
    samples: z
      .array(
        z.object({
          point: z.string().min(1).max(64),
          value: z.number(),
          at: z.iso.datetime({ offset: true }),
        }),
      )
      .min(1)
      .max(500),
  }),
});
