import type { Redis } from 'ioredis';

/** Minimal key-value contract for idempotency and rate limiting; Valkey in production, memory in unit tests. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** Set only if absent; returns true when this call created the key. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Atomic increment with TTL set on first increment; returns the new count and seconds until reset. */
  incrementWindow(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; resetInSeconds: number }>;
  delete(key: string): Promise<void>;
}
export const KV_STORE = Symbol('KV_STORE');

export class ValkeyKeyValueStore implements KeyValueStore {
  constructor(private readonly client: Redis) {}
  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }
  async incrementWindow(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; resetInSeconds: number }> {
    const results = await this.client.multi().incr(key).ttl(key).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    let ttl = Number(results?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.client.expire(key, windowSeconds);
      ttl = windowSeconds;
    }
    return { count, resetInSeconds: ttl };
  }
  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  private live(key: string): { value: string; expiresAt: number } | undefined {
    const e = this.map.get(key);
    if (e && e.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.map.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return true;
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }
  async incrementWindow(
    key: string,
    windowSeconds: number,
  ): Promise<{ count: number; resetInSeconds: number }> {
    const e = this.live(key);
    if (!e) {
      this.map.set(key, { value: '1', expiresAt: this.now() + windowSeconds * 1000 });
      return { count: 1, resetInSeconds: windowSeconds };
    }
    e.value = String(Number(e.value) + 1);
    return {
      count: Number(e.value),
      resetInSeconds: Math.max(1, Math.ceil((e.expiresAt - this.now()) / 1000)),
    };
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
