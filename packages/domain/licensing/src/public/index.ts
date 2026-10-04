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
