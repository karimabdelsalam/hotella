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
