import type { DeliveryQueue } from '@hotella/contracts-events';

/** The five queues of Spec §71. Guest real-time work never waits behind analytics or background AI. */
export const QUEUE_NAMES = [
  'critical-operational',
  'guest-realtime',
  'normal',
  'analytics',
  'background-ai',
] as const satisfies readonly DeliveryQueue[];
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Default per-process concurrency; tuned per deployment through WORKER_CONCURRENCY_<QUEUE> later. */
export const DEFAULT_CONCURRENCY: Record<QueueName, number> = {
  'critical-operational': 8,
  'guest-realtime': 16,
  normal: 8,
  analytics: 2,
  'background-ai': 2,
};

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/** Prefix keeps Hotella keys apart from anything else sharing the Valkey instance. */
export const QUEUE_PREFIX = 'hotella';
