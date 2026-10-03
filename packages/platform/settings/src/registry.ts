import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

export type ConfigScope = 'PLATFORM' | 'TENANT' | 'PROPERTY';
export const SCOPE_ORDER: readonly ConfigScope[] = ['PROPERTY', 'TENANT', 'PLATFORM'];

/**
 * A configuration key as code declares it (Spec §72): typed by a zod schema, with a default, a description in the
 * locale catalog, and the scopes at which it may be overridden. Values are validated on write and again on read.
 * Configuration ≠ entitlement ≠ feature flag ≠ permission (CLAUDE.md rule 14).
 */
export interface SettingDefinition<T = unknown> {
  readonly key: string;
  readonly scopes: readonly ConfigScope[];
  readonly schema: z.ZodType<T>;
  readonly default: T;
  readonly descriptionKey: string;
}

export const SETTING_KEY_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function defineSetting<T>(def: SettingDefinition<T>): SettingDefinition<T> {
  if (!SETTING_KEY_RE.test(def.key))
    throw new Error(`Setting key "${def.key}" must be <domain>.<entity>.<name>`);
  if (def.scopes.length === 0) throw new Error(`Setting "${def.key}" declares no scope`);
  const parsed = def.schema.safeParse(def.default);
  if (!parsed.success)
    throw new Error(`Default of setting "${def.key}" does not satisfy its schema`);
  return Object.freeze({ ...def, scopes: [...def.scopes] });
}

/** Every setting key the running modules declare; unknown keys cannot be written. */
@Injectable()
export class SettingsRegistry {
  private readonly defs = new Map<string, SettingDefinition>();

  register(...defs: SettingDefinition[]): void {
    for (const def of defs) {
      const existing = this.defs.get(def.key);
      if (existing && existing !== def) throw new Error(`Setting "${def.key}" registered twice`);
      this.defs.set(def.key, def);
    }
  }
  get(key: string): SettingDefinition | undefined {
    return this.defs.get(key);
  }
  all(): SettingDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

export interface StoredValue {
  readonly scope: ConfigScope;
  readonly value: unknown;
  readonly version: number;
}

export interface EffectiveValue<T> {
  readonly value: T;
  /** Where the value came from: a scope, or the code default. */
  readonly source: ConfigScope | 'DEFAULT';
  readonly version: number;
}

/**
 * Most specific wins: PROPERTY → TENANT → PLATFORM → default. A stored value the current schema rejects (the
 * definition tightened since it was written) is skipped, never returned.
 */
export function resolveEffective<T>(
  def: SettingDefinition<T>,
  stored: readonly StoredValue[],
  onInvalid?: (scope: ConfigScope) => void,
): EffectiveValue<T> {
  for (const scope of SCOPE_ORDER) {
    if (!def.scopes.includes(scope)) continue;
    const hit = stored.find((s) => s.scope === scope);
    if (!hit) continue;
    const parsed = def.schema.safeParse(hit.value);
    if (parsed.success) return { value: parsed.data, source: scope, version: hit.version };
    onInvalid?.(scope);
  }
  return { value: def.default, source: 'DEFAULT', version: 0 };
}
