/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export { LICENSING_MANIFEST } from '../manifest';
export { CAPABILITIES, CORE, METRICS } from '../domain/catalog';
export type { CapabilityDefinition, CapabilityKind, MetricDefinition } from '../domain/catalog';

/**
 * Entitlements for other contexts (Spec §58: `EntitlementEngine.can(tenant, property, capability)`; never compare plan
 * names). Inject with `@Optional() @Inject(ENTITLEMENT_API)`: compositions without the licensing context (module test
 * harnesses) get no checks, exactly like the pass-through gate stage.
 */
export interface EntitlementPublicApi {
  /** Is the capability entitled for the property (null: tenant-wide sources only) right now? */
  can(tenantId: string, propertyId: string | null, capability: string): Promise<boolean>;
  /** Until when the capability stays entitled (null: open-ended); undefined when it is not entitled. */
  entitledUntil(
    tenantId: string,
    propertyId: string | null,
    capability: string,
  ): Promise<Date | null | undefined>;
  /** Every entitled code, sorted. */
  effective(tenantId: string, propertyId: string | null): Promise<readonly string[]>;
  /**
   * Refuses (409 `license.limit_reached`) an action that would take a HARD-limited gauge past its limit; the caller
   * counts the current level (it owns the data). No limit, or a SOFT one, lets it through.
   */
  assertWithinLimit(input: {
    readonly tenantId: string;
    readonly propertyId: string | null;
    readonly metric: string;
    readonly current: number;
    readonly increment?: number;
  }): Promise<void>;
}
export const ENTITLEMENT_API = Symbol.for('hotella.domain.licensing.entitlements');

/** One measured occurrence (Spec §61). The idempotency key makes a repeat a no-op; no personal data. */
export interface UsageRecord {
  readonly tenantId: string;
  readonly propertyId: string | null;
  /** A metric of the catalog, e.g. `AI_INPUT_TOKENS`. */
  readonly metric: string;
  readonly quantity: number;
  readonly occurredAt?: Date;
  /** The context that measured it, e.g. `ai`. */
  readonly source: string;
  readonly idempotencyKey: string;
}

/**
 * Usage metering for other contexts. `record` joins the caller's transaction, so a measurement commits with the
 * business row it measures. `withinLimit` is false only when a HARD limit on a counter is used up for the period.
 */
export interface UsagePublicApi {
  record(input: UsageRecord): Promise<boolean>;
  withinLimit(tenantId: string, propertyId: string | null, metric: string): Promise<boolean>;
}
export const USAGE_API = Symbol.for('hotella.domain.licensing.usage');

/** A level the owning context counts (Spec §61 gauges: staff, properties): sampled once a day per licensed tenant. */
export interface UsageGaugeProvider {
  readonly metric: string;
  sample(tenantId: string): Promise<ReadonlyArray<{ propertyId: string | null; value: number }>>;
}
export interface UsageGaugeRegistrar {
  register(provider: UsageGaugeProvider): void;
}
export const USAGE_GAUGES = Symbol.for('hotella.domain.licensing.usage-gauges');
