/**
 * The commercial catalog (Spec §58, §59, §61): what can be sold and measured. It is defined in code, like permissions
 * and system roles, synchronised into `license.*` at boot (codes never deleted, only retired) and labelled through the
 * locale catalog (`license.capability.<code>`, `license.metric.<code>`). Plans, which administrators create, are
 * business data with translation tables.
 */

export const CAPABILITY_KINDS = ['MODULE', 'AI', 'CONNECTOR', 'ADDON', 'FEATURE'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface CapabilityDefinition {
  readonly code: string;
  readonly kind: CapabilityKind;
  /** FEATURE only: the module it belongs to. */
  readonly moduleCode?: string;
  /** FEATURE only: entitled with its module unless a plan must name it explicitly. */
  readonly defaultIncluded?: boolean;
}

export const PRODUCT_CODE = 'HOTELLA';

/** Every published plan version must grant it: organisation, identity, guests and stays, operations, integrations. */
export const CORE = 'CORE';

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  // Modules (Spec §59)
  { code: CORE, kind: 'MODULE' },
  { code: 'GUEST_EXPERIENCE', kind: 'MODULE' },
  { code: 'HOUSEKEEPING', kind: 'MODULE' },
  { code: 'ENGINEERING', kind: 'MODULE' },
  { code: 'INSPECTIONS', kind: 'MODULE' },
  { code: 'GUEST_RELATIONS', kind: 'MODULE' },
  { code: 'LOST_FOUND', kind: 'MODULE' },
  { code: 'LOGBOOK', kind: 'MODULE' },
  { code: 'AI_PRO', kind: 'MODULE' },
  { code: 'AI_INTELLIGENCE', kind: 'MODULE' },
  { code: 'VOICE_AI', kind: 'MODULE' },
  // AI entitlements
  { code: 'AI_CORE', kind: 'AI' },
  { code: 'AI_GUEST', kind: 'AI' },
  { code: 'AI_STAFF', kind: 'AI' },
  { code: 'AI_HOUSEKEEPING', kind: 'AI' },
  { code: 'AI_ENGINEERING', kind: 'AI' },
  { code: 'AI_MANAGER', kind: 'AI' },
  { code: 'AI_VISION', kind: 'AI' },
  { code: 'AI_VOICE', kind: 'AI' },
  { code: 'AI_PREDICTIVE', kind: 'AI' },
  // Connector entitlements
  { code: 'CONNECTOR_PMS', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_OPERA5', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_OPERA_CLOUD', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_POS', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_BMS', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_PBX', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_ERP', kind: 'CONNECTOR' },
  { code: 'CONNECTOR_WIFI', kind: 'CONNECTOR' },
  // Add-ons
  { code: 'API_ACCESS', kind: 'ADDON' },
  { code: 'WHITE_LABEL', kind: 'ADDON' },
];

export const METRIC_UNITS = ['TOKENS', 'COUNT', 'MINUTES', 'BYTES', 'CALLS'] as const;
export const METRIC_KINDS = ['COUNTER', 'GAUGE'] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export interface MetricDefinition {
  readonly code: string;
  readonly unit: (typeof METRIC_UNITS)[number];
  /** COUNTER: summed per period (tokens, calls). GAUGE: a level sampled over time (staff, properties, bytes). */
  readonly kind: MetricKind;
}

/** Spec §61. */
export const METRICS: readonly MetricDefinition[] = [
  { code: 'AI_INPUT_TOKENS', unit: 'TOKENS', kind: 'COUNTER' },
  { code: 'AI_OUTPUT_TOKENS', unit: 'TOKENS', kind: 'COUNTER' },
  { code: 'AI_VISION', unit: 'COUNT', kind: 'COUNTER' },
  { code: 'VOICE_MINUTES', unit: 'MINUTES', kind: 'COUNTER' },
  { code: 'WHATSAPP_CONVERSATIONS', unit: 'COUNT', kind: 'COUNTER' },
  { code: 'STORAGE_BYTES', unit: 'BYTES', kind: 'GAUGE' },
  { code: 'ACTIVE_STAFF', unit: 'COUNT', kind: 'GAUGE' },
  { code: 'ACTIVE_PROPERTIES', unit: 'COUNT', kind: 'GAUGE' },
  { code: 'API_CALLS', unit: 'CALLS', kind: 'COUNTER' },
];

/** Locale keys of catalog labels. */
export const capabilityLabelKey = (code: string): string =>
  `license.capability.${code.toLowerCase()}`;
export const metricLabelKey = (code: string): string => `license.metric.${code.toLowerCase()}`;
