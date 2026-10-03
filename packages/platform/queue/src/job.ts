import type { RequestContextData } from '@hotella/platform-observability';

/** Every job carries the request context so logs/audit in the worker continue the same correlation id. */
export interface JobEnvelope<T = unknown> {
  readonly data: T;
  readonly context: Partial<RequestContextData>;
  readonly enqueuedAt: string;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 } as const,
  removeOnComplete: { count: 1_000, age: 24 * 3600 },
  // Failed jobs stay (the queue's failed set IS the dead-letter queue) until replayed or purged by ops.
  removeOnFail: false as const,
};
