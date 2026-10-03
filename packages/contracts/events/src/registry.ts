import { z, type ZodType } from 'zod';
import {
  DELIVERY_QUEUES,
  type DeliveryQueue,
  EVENT_TYPE_RE,
  type EventEnvelope,
  eventEnvelopeSchema,
  eventName,
} from './envelope';

export interface EventDefinitionInput<P extends ZodType> {
  readonly type: string;
  readonly version: number;
  readonly payload: P;
  readonly description: string;
  /** Default `normal`. Guest-facing real-time flows choose `guest-realtime`; SLA/alerts `critical-operational`. */
  readonly delivery?: DeliveryQueue;
  /** Required for `hotel.*` canonical events produced by the Integration Platform. */
  readonly canonical?: boolean;
}

export interface EventDefinition<P extends ZodType = ZodType> {
  readonly name: string;
  readonly type: string;
  readonly version: number;
  readonly description: string;
  readonly delivery: DeliveryQueue;
  readonly canonical: boolean;
  readonly payload: P;
  /** Envelope schema with the payload refined to this event. */
  readonly schema: ZodType<EventEnvelope<z.infer<P>>>;
  parse(value: unknown): EventEnvelope<z.infer<P>>;
}

export class EventDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventDefinitionError';
  }
}

const registry = new Map<string, EventDefinition>();

/**
 * Declares an immutable, versioned event. Material payload changes require a new version (Spec §51).
 * Registering the same type+version twice is an error (two packages claiming one event).
 */
export function defineEvent<P extends ZodType>(input: EventDefinitionInput<P>): EventDefinition<P> {
  if (!EVENT_TYPE_RE.test(input.type)) {
    throw new EventDefinitionError(
      `Invalid event type "${input.type}". Expected <context>.<entity>.<past_tense_event> in snake_case.`,
    );
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new EventDefinitionError(`Invalid version for "${input.type}": ${input.version}`);
  }
  const isHotel = input.type.startsWith('hotel.');
  if (isHotel && !input.canonical) {
    throw new EventDefinitionError(
      `"${input.type}" uses the reserved hotel.* namespace; only canonical PMS events may (set canonical: true).`,
    );
  }
  if (!isHotel && input.canonical) {
    throw new EventDefinitionError(
      `Canonical events must use the hotel.* namespace (got "${input.type}").`,
    );
  }
  if (input.delivery && !DELIVERY_QUEUES.includes(input.delivery)) {
    throw new EventDefinitionError(`Unknown delivery queue "${input.delivery}"`);
  }
  const name = eventName(input.type, input.version);
  if (registry.has(name)) throw new EventDefinitionError(`Event "${name}" is already defined.`);

  const schema = eventEnvelopeSchema.omit({ payload: true }).extend({
    payload: input.payload,
    event_type: z.literal(input.type),
    event_version: z.literal(input.version),
  }) as unknown as ZodType<EventEnvelope<z.infer<P>>>;

  const def: EventDefinition<P> = {
    name,
    type: input.type,
    version: input.version,
    description: input.description,
    delivery: input.delivery ?? 'normal',
    canonical: Boolean(input.canonical),
    payload: input.payload,
    schema,
    parse: (value) => schema.parse(value),
  };
  registry.set(name, def as EventDefinition);
  return def;
}

export function getEventDefinition(name: string): EventDefinition | undefined {
  return registry.get(name);
}

export function listEventDefinitions(): EventDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test-only: clears the registry between isolated test files. */
export function resetEventRegistryForTests(): void {
  registry.clear();
}

export interface EnvelopeInput<P> {
  readonly eventId: string;
  readonly tenantId: string | null;
  readonly propertyId: string | null;
  readonly source: string;
  readonly sourceReference?: string | null;
  readonly correlationId: string | null;
  readonly occurredAt?: Date;
  readonly receivedAt?: Date;
  readonly payload: P;
}

/** Builds and validates an envelope for a definition. The caller supplies the id (UUIDv7 from the platform). */
export function createEnvelope<P extends ZodType>(
  def: EventDefinition<P>,
  input: EnvelopeInput<z.infer<P>>,
): EventEnvelope<z.infer<P>> {
  const now = new Date();
  return def.parse({
    event_id: input.eventId,
    event_type: def.type,
    event_version: def.version,
    tenant_id: input.tenantId,
    property_id: input.propertyId,
    source: input.source,
    source_reference: input.sourceReference ?? null,
    occurred_at: (input.occurredAt ?? now).toISOString(),
    received_at: (input.receivedAt ?? now).toISOString(),
    correlation_id: input.correlationId,
    payload: input.payload,
  });
}
