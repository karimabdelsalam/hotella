/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
import type { ConnectorCapability } from '@hotella/contracts-connectors';

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
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const INTEGRATIONS_API = Symbol.for('hotella.domain.integrations.api');

/** External entity kinds used across connectors. */
export const EXTERNAL_ENTITY = { RESERVATION: 'RESERVATION', PROFILE: 'PROFILE' } as const;

export { INTEGRATIONS_MANIFEST } from '../manifest';
