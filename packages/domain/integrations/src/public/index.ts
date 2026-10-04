/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
import type {
  ConnectorCapability,
  PmsProfileRow,
  PmsReservationRow,
  PmsRoomRow,
} from '@hotella/contracts-connectors';

export interface ExternalReferenceSummary {
  readonly integrationInstanceId: string;
  readonly internalEntityType: string;
  readonly internalEntityId: string;
  readonly externalEntityType: string;
  readonly externalId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface LinkReferenceInput {
  readonly tenantId: string;
  readonly integrationInstanceId: string;
  /** `<context>.<entity>`, e.g. `guest.stay`, `guest.guest`. */
  readonly internalEntityType: string;
  readonly internalEntityId: string;
  /** Source-side entity kind, e.g. `RESERVATION`, `PROFILE`. */
  readonly externalEntityType: string;
  readonly externalId: string;
}

export interface IntegrationInstanceSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly connectorCode: string;
  readonly name: string;
  readonly status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'DISABLED';
  readonly effectiveCapabilities: readonly ConnectorCapability[];
}

/**
 * External/PMS ids stay inside the Integration Platform (CLAUDE.md rule 3): other contexts resolve and link them only
 * through this API, inside their own transaction (calls join the ambient unit of work).
 */
export interface IntegrationsPublicApi {
  /** Internal id linked to an external id, or null. */
  resolveReference(
    tenantId: string,
    integrationInstanceId: string,
    externalEntityType: string,
    externalId: string,
  ): Promise<string | null>;
  /** Links an external id; when another internal entity already holds it, that one wins and its id is returned. */
  linkReference(input: LinkReferenceInput): Promise<string>;
  referencesFor(
    tenantId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<readonly ExternalReferenceSummary[]>;
  /** Moves every reference of one internal entity to another (guest merge); returns the number moved. */
  repointReferences(
    tenantId: string,
    internalEntityType: string,
    fromId: string,
    toId: string,
  ): Promise<number>;
  /** Spec §47: does any active integration of the property currently serve this capability? */
  hasCapability(
    tenantId: string,
    propertyId: string,
    capability: ConnectorCapability,
  ): Promise<boolean>;
  listInstances(
    tenantId: string,
    propertyId: string,
  ): Promise<readonly IntegrationInstanceSummary[]>;
  /**
   * Queues a durable outbound command (Spec §53) for delivery over the agent link. The command type must be declared
   * by the connector, its capability negotiated, and its payload valid; the same idempotency key returns the same
   * command. Callers check permissions (ActionGate) and audit the business action that caused it.
   */
  requestCommand(input: CommandRequest): Promise<CommandSummary>;
  getCommand(tenantId: string, commandId: string): Promise<CommandSummary | null>;
  /** Removes every external link of an internal entity (anonymization: the PMS profile no longer resolves to it). */
  unlinkExternalIdentity(
    tenantId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<number>;
  /**
   * Replaces the raw payload of every stored vendor message about these reservations with a tombstone (data-subject
   * requests, Spec §69); message metadata, statuses and canonical event ids stay for traceability.
   */
  scrubRawMessages(
    tenantId: string,
    integrationInstanceId: string,
    reservationExternalIds: readonly string[],
  ): Promise<number>;
  /** The PMS in-house snapshot of a reconciliation run (Spec §52), for the stay owner to compare. */
  reconciliationSnapshot(tenantId: string, runId: string): Promise<ReconciliationSnapshot | null>;
  /**
   * Records the comparison; every non-MATCH finding opens an integration exception. Idempotent: a run that is
   * already complete is left unchanged.
   */
  completeReconciliation(
    tenantId: string,
    runId: string,
    findings: readonly ReconciliationFinding[],
  ): Promise<void>;
}

export interface ReconciliationSnapshot {
  readonly runId: string;
  readonly integrationInstanceId: string;
  readonly propertyId: string;
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly entries: ReadonlyArray<{
    readonly externalId: string;
    readonly roomId: string | null;
    readonly roomCode: string | null;
  }>;
}

export type ReconciliationOutcome = 'MATCH' | 'MISSING_INTERNAL' | 'MISSING_EXTERNAL' | 'DIFFERENT';

export interface ReconciliationFinding {
  readonly entityType: 'STAY';
  readonly outcome: ReconciliationOutcome;
  /** Reservation id in the source system, when the PMS reported it. */
  readonly externalId: string | null;
  /** Internal stay, when the platform has one. */
  readonly internalId: string | null;
  /** What differs — ids, codes and states only, never guest data. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CommandRequest {
  readonly tenantId: string;
  readonly integrationInstanceId: string;
  readonly commandType: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly expiresAt?: Date | null;
  readonly requestedBy: { readonly type: string; readonly id: string | null };
  readonly correlationId?: string | null;
  /** Set by `PMS_API`: how the connector was chosen (guide §4.3), kept on the command for audit. */
  readonly routing?: Readonly<Record<string, unknown>> | null;
}

export interface CommandSummary {
  readonly id: string;
  readonly integrationInstanceId: string;
  readonly commandType: string;
  readonly status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'FAILED' | 'EXPIRED';
  readonly attempts: number;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly acknowledgedAt: Date | null;
}

/** Who asks the PMS for a write, and the key that makes a repeat a no-op. */
export interface PmsWriteContext {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly idempotencyKey: string;
  readonly requestedBy: { readonly type: string; readonly id: string | null };
  readonly correlationId?: string | null;
}

/**
 * QUEUED: a durable command for the chosen connector. UNAVAILABLE: no connector of the property may do it now.
 * NOT_LINKED: the PMS does not know this subject (no PMS reference), so there is nothing to update.
 */
export type PmsWriteOutcome =
  | {
      readonly outcome: 'QUEUED';
      readonly commandId: string;
      readonly connectorCode: string;
      readonly status: CommandSummary['status'];
    }
  | { readonly outcome: 'UNAVAILABLE'; readonly capability: ConnectorCapability }
  /** The write needs a PMS id (profile, reservation) the PMS never gave the platform for this subject. */
  | { readonly outcome: 'NOT_LINKED'; readonly capability: ConnectorCapability };

/** Who asks the PMS for a read (no idempotency: reads change nothing). */
export interface PmsReadContext {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly requestedBy: { readonly type: string; readonly id: string | null };
  readonly correlationId?: string | null;
  /** How long to wait for the hotel's agent (default 15 s, at most 60 s). */
  readonly deadlineMs?: number;
}

/**
 * OK: rows from the first connector that answered. UNAVAILABLE: no connector of the property may do it.
 * FAILED: every connector that may do it failed or did not answer in time (each attempt listed).
 */
export type PmsReadOutcome<R> =
  | {
      readonly outcome: 'OK';
      readonly connectorCode: string;
      readonly rows: readonly R[];
      readonly truncated: boolean;
    }
  | { readonly outcome: 'UNAVAILABLE'; readonly capability: ConnectorCapability }
  | {
      readonly outcome: 'FAILED';
      readonly capability: ConnectorCapability;
      readonly attempts: ReadonlyArray<{ readonly connectorCode: string; readonly status: string }>;
    };

/**
 * The Unified OPERA Adapter (ADR-0019; guide §4) — vendor-neutral by name: the only way a module reaches the PMS. It
 * asks the per-property capability registry which connector may serve each operation and never writes through a
 * read-only connector. Reads go over link protocol 2 to the first connector that may serve them and fall through to the
 * next one when an agent is unreachable or fails; writes never fall through.
 */
export interface PmsPublicApi {
  /** Spec §47: may the property's PMS integration do this now? For modules, the UI and the AI tools. */
  can(tenantId: string, propertyId: string, capability: ConnectorCapability): Promise<boolean>;
  lookupReservation(
    input: PmsReadContext &
      ({ readonly confirmationNumber: string } | { readonly reservationId: string }),
  ): Promise<PmsReadOutcome<PmsReservationRow>>;
  /** Arrivals between two local dates (at most 31 days). */
  listArrivals(
    input: PmsReadContext & { readonly from: string; readonly to: string },
  ): Promise<PmsReadOutcome<PmsReservationRow>>;
  inHouseSnapshot(input: PmsReadContext): Promise<PmsReadOutcome<PmsReservationRow>>;
  lookupProfile(
    input: PmsReadContext & { readonly profileId: string },
  ): Promise<PmsReadOutcome<PmsProfileRow>>;
  roomInventory(input: PmsReadContext): Promise<PmsReadOutcome<PmsRoomRow>>;
  setRoomStatus(
    input: PmsWriteContext & {
      readonly roomNumber: string;
      readonly status: 'DIRTY' | 'CLEAN' | 'INSPECTED';
      /** FIAS room status codes carry occupancy; the PMS's own occupancy as last seen. */
      readonly occupied?: boolean;
    },
  ): Promise<PmsWriteOutcome>;
  setRoomRestriction(
    input: PmsWriteContext & {
      readonly roomNumber: string;
      readonly kind: 'OOO' | 'OOS' | 'BLOCKED_OPERATIONALLY';
      readonly active: boolean;
    },
  ): Promise<PmsWriteOutcome>;
  /**
   * Adds an e-mail and/or mobile number to the PMS profile of an internal subject (e.g. `guest.guest`) as its primary
   * contact; existing contacts are never replaced. The PMS profile id stays inside the integration context.
   */
  updateProfileContact(
    input: PmsWriteContext & {
      readonly subject: { readonly entityType: string; readonly id: string };
      readonly email?: string;
      readonly phone?: string;
    },
  ): Promise<PmsWriteOutcome>;
}

export const PMS_API = Symbol.for('hotella.domain.integrations.pms');

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const INTEGRATIONS_API = Symbol.for('hotella.domain.integrations.api');

/** External entity kinds used across connectors. */
export const EXTERNAL_ENTITY = { RESERVATION: 'RESERVATION', PROFILE: 'PROFILE' } as const;

export { INTEGRATIONS_MANIFEST } from '../manifest';
