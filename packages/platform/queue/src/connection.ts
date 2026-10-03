import { Redis, type RedisOptions } from 'ioredis';

/**
 * Shared Valkey (RESP) connection factory. BullMQ requires `maxRetriesPerRequest: null`.
 * Wherever the codebase says "Redis" generically it means this Valkey connection (ADR-0016).
 */
export function createValkeyConnection(url: string, options: RedisOptions = {}): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: 5_000,
    ...options,
  });
  client.on('error', () => undefined); // surfaced via health probes and job failures, never a crash
  return client;
}
