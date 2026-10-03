import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Guest service catalog events (Spec §7, BUILD_PLAN §9). Payloads carry ids, codes and states only — never field
 * values (they may quote the guest); consumers that need content read it through the catalog context.
 */

export const SERVICE_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export const SERVICE_REQUEST_SOURCES = ['GUEST_WEB', 'WHATSAPP', 'STAFF', 'AI', 'QR'] as const;
const status = z.enum(SERVICE_REQUEST_STATUSES);
const source = z.enum(SERVICE_REQUEST_SOURCES);

export const ServiceVersionPublished = defineEvent({
  type: 'catalog.service_version.published',
  version: 1,
  description:
    'A service version was published (it is immutable from now on) and replaced the previous one for new requests.',
  payload: z.object({
    definition_id: z.uuid(),
    version_id: z.uuid(),
    service_code: z.string(),
    version_no: z.number().int().min(1),
    property_id: z.uuid().nullable(),
    superseded_version_id: z.uuid().nullable(),
  }),
});

export const ServiceRequestCreated = defineEvent({
  type: 'catalog.service_request.created',
  version: 1,
  delivery: 'guest-realtime',
  description:
    'A guest (or staff or AI on their behalf) requested a service; its work item exists.',
  payload: z.object({
    request_id: z.uuid(),
    service_code: z.string(),
    service_version_id: z.uuid(),
    stay_id: z.uuid(),
    guest_id: z.uuid(),
    room_id: z.uuid().nullable(),
    work_item_id: z.uuid(),
    source,
  }),
});

export const ServiceRequestStatusChanged = defineEvent({
  type: 'catalog.service_request.status_changed',
  version: 1,
  delivery: 'guest-realtime',
  description:
    'A service request moved on (following its work item, or cancelled by the guest or staff).',
  payload: z.object({
    request_id: z.uuid(),
    service_code: z.string(),
    stay_id: z.uuid(),
    guest_id: z.uuid(),
    from: status,
    to: status,
  }),
});

export const ServiceRequestRelated = defineEvent({
  type: 'catalog.service_request.related',
  version: 1,
  delivery: 'guest-realtime',
  description:
    'The same stay asked again for a service it already has open: the ask was related to the open request instead of duplicating it (Spec §23).',
  payload: z.object({
    request_id: z.uuid(),
    service_code: z.string(),
    stay_id: z.uuid(),
    guest_id: z.uuid(),
    related_count: z.number().int().min(1),
    source,
  }),
});
