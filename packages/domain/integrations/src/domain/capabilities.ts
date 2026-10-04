import {
  type ConnectorCapability,
  type IntegrationHealthState,
  isWriteCapability,
} from '@hotella/contracts-connectors';

/**
 * Unified OPERA Adapter and per-property capability registry (ADR-0019; OPERA Integration Guide §4–§5): which
 * connector of a property may serve a business capability right now, and in which order the operations of `PMS_API`
 * try them. Pure and deterministic (CLAUDE.md rule 11).
 */

/** Live availability of a connector instance, from its health (Spec §57). */
export type CapabilityStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';

/**
 * HEALTHY serves; DEGRADED and OFFLINE serve degraded (commands are durable and wait for the agent, reads fall through
 * to the next connector); a misconfigured or unauthorised link cannot serve until someone fixes it.
 */
export function statusFromHealth(health: IntegrationHealthState | null): CapabilityStatus {
  switch (health) {
    case 'HEALTHY':
      return 'AVAILABLE';
    case 'MISCONFIGURED':
    case 'AUTH_FAILED':
      return 'UNAVAILABLE';
    default:
      return 'DEGRADED';
  }
}

export type IneffectiveReason =
  | 'INSTANCE_INACTIVE'
  | 'NOT_SUPPORTED'
  | 'NOT_ENABLED'
  | 'NOT_REPORTED'
  | 'NOT_LICENSED'
  | 'NOT_VERIFIED'
  | 'UNAVAILABLE';

/** What the registry knows about one connector instance of a property for one capability (guide §5.2). */
export interface CapabilityFacts {
  readonly instanceId: string;
  readonly connectorCode: string;
  readonly instanceActive: boolean;
  /** The connector manifest can serve it. */
  readonly supported: boolean;
  /** The hotel enabled it on the instance. */
  readonly enabled: boolean;
  /** The agent announced it; null while no agent has reported (push connectors, before the first connect). */
  readonly reported: boolean | null;
  /** The tenant holds the connector's entitlement at the property (Spec §62). */
  readonly licensed: boolean;
  /** Proven at commissioning (guide §16.5). */
  readonly verified: boolean;
  /** The instance passed its commissioning sign-off: from then on every capability must be verified. */
  readonly commissioned: boolean;
  readonly status: CapabilityStatus;
}

/**
 * `effective = supported ∧ enabled ∧ reported ∧ licence ∧ verified ∧ status ≠ UNAVAILABLE` (guide §5.3). Writes always
 * need verification; reads and events run unverified only while the instance is still in commissioning.
 */
export function ineffectiveReasons(
  capability: ConnectorCapability,
  f: CapabilityFacts,
): IneffectiveReason[] {
  const reasons: IneffectiveReason[] = [];
  if (!f.instanceActive) reasons.push('INSTANCE_INACTIVE');
  if (!f.supported) reasons.push('NOT_SUPPORTED');
  if (!f.enabled) reasons.push('NOT_ENABLED');
  if (f.reported === false) reasons.push('NOT_REPORTED');
  if (!f.licensed) reasons.push('NOT_LICENSED');
  if (!f.verified && (isWriteCapability(capability) || f.commissioned))
    reasons.push('NOT_VERIFIED');
  if (f.status === 'UNAVAILABLE') reasons.push('UNAVAILABLE');
  return reasons;
}

/** PMS connectors known to the routing table, in the vendor-neutral roles of the guide. */
export const OPERA_DB = 'OPERA5_DB';
export const OPERA_FIAS = 'OPERA5_FIAS';
export const OPERA_OWS = 'OPERA5_OWS';
/** The simulator stands in for any of them in development, CI and demos. */
export const SIM_PMS = 'SIM_PMS';

export interface PmsOperationDefinition {
  readonly kind: 'read' | 'write';
  readonly capability: ConnectorCapability;
  /** Default preference order (guide §4.2); a property may reorder within it, never extend it. */
  readonly connectors: readonly string[];
  /** The connector command a write becomes. */
  readonly command?: string;
}

/** Operations of `PMS_API` v1 (guide §4.2). No operation lists the database as a write target. */
export const PMS_OPERATIONS = {
  LOOKUP_RESERVATION: {
    kind: 'read',
    capability: 'RESERVATION_LOOKUP',
    connectors: [OPERA_DB, OPERA_OWS, SIM_PMS],
  },
  LIST_ARRIVALS: {
    kind: 'read',
    capability: 'ARRIVALS_READ',
    connectors: [OPERA_DB, OPERA_OWS, SIM_PMS],
  },
  IN_HOUSE_SNAPSHOT: {
    kind: 'read',
    capability: 'IN_HOUSE_SNAPSHOT',
    connectors: [OPERA_DB, OPERA_FIAS, OPERA_OWS, SIM_PMS],
  },
  LOOKUP_PROFILE: {
    kind: 'read',
    capability: 'PROFILE_LOOKUP',
    connectors: [OPERA_DB, OPERA_OWS, SIM_PMS],
  },
  ROOM_INVENTORY: { kind: 'read', capability: 'ROOM_INVENTORY_READ', connectors: [OPERA_DB] },
  RECONCILIATION_SNAPSHOT: {
    kind: 'read',
    capability: 'RECONCILIATION_READ',
    connectors: [OPERA_DB, OPERA_FIAS, OPERA_OWS, SIM_PMS],
  },
  SET_ROOM_STATUS: {
    kind: 'write',
    capability: 'ROOM_STATUS_WRITE',
    connectors: [OPERA_FIAS, OPERA_OWS, SIM_PMS],
    command: 'SET_ROOM_STATUS',
  },
  SET_ROOM_RESTRICTION: {
    kind: 'write',
    capability: 'OOO_WRITE',
    connectors: [OPERA_OWS, OPERA_FIAS, SIM_PMS],
    command: 'SET_ROOM_RESTRICTION',
  },
  UPDATE_PROFILE_CONTACT: {
    kind: 'write',
    capability: 'PROFILE_WRITE',
    connectors: [OPERA_OWS, SIM_PMS],
    command: 'UPDATE_PROFILE_CONTACT',
  },
  UPDATE_RESERVATION_NOTE: {
    kind: 'write',
    capability: 'RESERVATION_WRITE',
    connectors: [OPERA_OWS, SIM_PMS],
    command: 'UPDATE_RESERVATION_NOTE',
  },
} as const satisfies Record<string, PmsOperationDefinition>;
export type PmsOperation = keyof typeof PMS_OPERATIONS;
export const PMS_OPERATION_CODES = Object.keys(PMS_OPERATIONS) as PmsOperation[];

export function isPmsOperation(value: string): value is PmsOperation {
  return Object.hasOwn(PMS_OPERATIONS, value);
}

export type OverrideProblem = 'EMPTY' | 'DUPLICATE' | 'NOT_ALLOWED' | 'READ_ONLY_WRITE_TARGET';

/**
 * A property's own order for an operation: a permutation of a subset of the operation's connectors. A read-only
 * connector (the database) is refused as a write target even if a future table listed it — the database is never
 * written (ADR-0019), whatever the configuration says.
 */
export function overrideProblem(
  operation: PmsOperation,
  connectors: readonly string[],
  isReadOnly: (connectorCode: string) => boolean,
): OverrideProblem | null {
  const op: PmsOperationDefinition = PMS_OPERATIONS[operation];
  if (connectors.length === 0) return 'EMPTY';
  if (new Set(connectors).size !== connectors.length) return 'DUPLICATE';
  if (op.kind === 'write' && connectors.some(isReadOnly)) return 'READ_ONLY_WRITE_TARGET';
  if (connectors.some((c) => !op.connectors.includes(c))) return 'NOT_ALLOWED';
  return null;
}

export interface RouteCandidate {
  readonly instanceId: string;
  readonly connectorCode: string;
  readonly readOnly: boolean;
  readonly reasons: readonly IneffectiveReason[];
  readonly status: CapabilityStatus;
}

export interface RoutingDecision {
  readonly operation: PmsOperation;
  /** Effective connectors in the order they are tried (a write uses only the first). */
  readonly route: ReadonlyArray<{ readonly instanceId: string; readonly connectorCode: string }>;
  /** Every candidate with why it was left out, for audit and the registry screen. */
  readonly skipped: ReadonlyArray<{
    readonly instanceId: string;
    readonly connectorCode: string;
    readonly reasons: readonly (IneffectiveReason | 'NOT_IN_ROUTE' | 'READ_ONLY')[];
  }>;
}

/**
 * Guide §4.3: take the preference order (the property's override, else the default), keep the connectors whose
 * capability is effective, and for reads try AVAILABLE ones before DEGRADED ones. A write never goes to a read-only
 * connector. Several instances of one connector keep their given order (oldest first).
 */
export function route(
  operation: PmsOperation,
  candidates: readonly RouteCandidate[],
  override?: readonly string[] | null,
): RoutingDecision {
  const op: PmsOperationDefinition = PMS_OPERATIONS[operation];
  const order = override && override.length ? override : op.connectors;
  const rank = (code: string) => order.indexOf(code);
  const skipped: Array<RoutingDecision['skipped'][number]> = [];
  const eligible: RouteCandidate[] = [];
  for (const c of candidates) {
    if (op.kind === 'write' && c.readOnly)
      skipped.push({
        instanceId: c.instanceId,
        connectorCode: c.connectorCode,
        reasons: ['READ_ONLY'],
      });
    else if (rank(c.connectorCode) < 0)
      skipped.push({
        instanceId: c.instanceId,
        connectorCode: c.connectorCode,
        reasons: ['NOT_IN_ROUTE'],
      });
    else if (c.reasons.length > 0)
      skipped.push({
        instanceId: c.instanceId,
        connectorCode: c.connectorCode,
        reasons: c.reasons,
      });
    else eligible.push(c);
  }
  const degraded = (c: RouteCandidate) => (op.kind === 'read' && c.status === 'DEGRADED' ? 1 : 0);
  const ordered = eligible
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        degraded(a.c) - degraded(b.c) ||
        rank(a.c.connectorCode) - rank(b.c.connectorCode) ||
        a.i - b.i,
    )
    .map(({ c }) => ({ instanceId: c.instanceId, connectorCode: c.connectorCode }));
  return { operation, route: ordered, skipped };
}
