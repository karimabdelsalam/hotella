/** Capabilities agents ask for (Spec §28); never a model name. */
export const CAPABILITIES = [
  'REASONING_HIGH',
  'FAST_CLASSIFICATION',
  'VISION',
  'TRANSLATION',
  'EMBEDDING',
  'AUDIO',
  'STRUCTURED_OUTPUT',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface RoutingRule {
  readonly tenantId: string | null;
  readonly propertyId: string | null;
  readonly capability: string;
  readonly modelIds: readonly string[];
}

/**
 * The most specific rule for a capability: the property's, else the tenant's, else the platform default. Deterministic
 * (rule 11); null when nothing routes the capability.
 */
export function pickRule(
  rules: readonly RoutingRule[],
  capability: string,
  at: { readonly tenantId: string; readonly propertyId: string | null },
): RoutingRule | null {
  const forCap = rules.filter((r) => r.capability === capability);
  return (
    (at.propertyId
      ? forCap.find((r) => r.tenantId === at.tenantId && r.propertyId === at.propertyId)
      : undefined) ??
    forCap.find((r) => r.tenantId === at.tenantId && r.propertyId === null) ??
    forCap.find((r) => r.tenantId === null && r.propertyId === null) ??
    null
  );
}

/** Estimated cost in minor currency units from per-million-token prices (integer math, rounded up). */
export function estimateCostMinor(
  usage: { readonly input: number; readonly output: number; readonly cached: number },
  price: {
    readonly inputPerMillionMinor: number;
    readonly outputPerMillionMinor: number;
    readonly cachedPerMillionMinor: number;
  },
): number {
  const micro =
    usage.input * price.inputPerMillionMinor +
    usage.output * price.outputPerMillionMinor +
    usage.cached * price.cachedPerMillionMinor;
  return Math.ceil(micro / 1_000_000);
}
