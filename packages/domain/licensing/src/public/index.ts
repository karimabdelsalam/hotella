/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export { LICENSING_MANIFEST } from '../manifest';
export { CAPABILITIES, CORE, METRICS } from '../domain/catalog';
export type { CapabilityDefinition, CapabilityKind, MetricDefinition } from '../domain/catalog';
