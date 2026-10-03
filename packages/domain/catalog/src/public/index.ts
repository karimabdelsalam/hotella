/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export type ServiceRequestStatus = 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type ServiceRequestSource = 'GUEST_WEB' | 'WHATSAPP' | 'STAFF' | 'AI' | 'QR';

/**
 * One ask for a service (Spec §7, §23). The actor comes from the request context: a guest (their session's scope is
 * checked), staff on a guest's behalf (`request.create`), or later an AI agent through its tool (Phase 6).
 */
export interface CreateServiceRequestInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly stayId: string;
  readonly guestId: string;
  readonly serviceCode: string;
  /** Values for the version's required fields; TEXT values are the guest's words. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** ISO timestamp with offset, when the service allows scheduling. */
  readonly requestedForAt?: string | null;
  /** The language the guest asked in; they are answered in it. */
  readonly locale: string;
  readonly source: ServiceRequestSource;
  readonly conversationId?: string | null;
}

export interface ServiceRequestSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly serviceCode: string;
  readonly serviceVersionId: string;
  readonly stayId: string;
  readonly guestId: string;
  readonly roomId: string | null;
  readonly workItemId: string | null;
  readonly status: ServiceRequestStatus;
  readonly requestedForAt: string | null;
  readonly locale: string;
  readonly source: ServiceRequestSource;
  readonly relatedCount: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface CreatedServiceRequest {
  readonly request: ServiceRequestSummary;
  /** True when an open request of the stay for this service already existed and the ask was related to it. */
  readonly related: boolean;
}

/** The single entrypoint for service requests (BUILD_PLAN §9.2): staff UI, guest web, and the AI tool in Phase 6. */
export interface CatalogPublicApi {
  createServiceRequest(input: CreateServiceRequestInput): Promise<CreatedServiceRequest>;
  getServiceRequest(tenantId: string, id: string): Promise<ServiceRequestSummary | null>;
  serviceRequestsOfStay(
    tenantId: string,
    stayId: string,
  ): Promise<readonly ServiceRequestSummary[]>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const CATALOG_API = Symbol.for('hotella.domain.catalog.api');

export { CATALOG_MANIFEST } from '../manifest';
