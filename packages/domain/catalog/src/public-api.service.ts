import { Injectable } from '@nestjs/common';
import { isUuid, TransactionRunner } from '@hotella/platform-database';
import { RequestRepositories } from './infrastructure/request-repositories';
import { CatalogReader } from './application/catalog-reader';
import { ServiceRequestService, summary } from './application/request.service';
import type {
  CatalogPublicApi,
  CreatedServiceRequest,
  CreateServiceRequestInput,
  GuestServiceSummary,
  ServiceRequestSummary,
} from './public';

@Injectable()
export class CatalogPublicApiService implements CatalogPublicApi {
  constructor(
    private readonly requests: ServiceRequestService,
    private readonly repo: RequestRepositories,
    private readonly reader: CatalogReader,
    private readonly tx: TransactionRunner,
  ) {}

  cancelServiceRequest(
    tenantId: string,
    propertyId: string,
    id: string,
    reason: string,
  ): Promise<ServiceRequestSummary> {
    return this.requests.cancelByStaff({ tenantId, propertyId }, id, reason);
  }

  servicesForGuest(input: {
    tenantId: string;
    propertyId: string;
    stayId: string;
    guestId: string;
    locale: string;
  }): Promise<readonly GuestServiceSummary[]> {
    return this.tx.read(async () => {
      const catalog = await this.reader.guestCatalog(
        {
          tenantId: input.tenantId,
          propertyId: input.propertyId,
          stayId: input.stayId,
          guestId: input.guestId,
          grantId: '',
          sessionId: '',
          scopes: ['SERVICE_REQUEST'],
        },
        input.locale,
      );
      return catalog.categories.flatMap((c) =>
        c.services.map((s) => ({
          code: s.code,
          name: s.name,
          shortDescription: s.shortDescription,
          openNow: s.openNow,
          fields: s.fields,
        })),
      );
    });
  }

  createServiceRequest(input: CreateServiceRequestInput): Promise<CreatedServiceRequest> {
    return this.requests.create(input);
  }
  getServiceRequest(tenantId: string, id: string): Promise<ServiceRequestSummary | null> {
    return this.tx.read(async () => {
      const r = isUuid(id) ? await this.repo.get({ tenantId }, id) : undefined;
      return r ? summary(r) : null;
    });
  }
  serviceRequestsOfStay(
    tenantId: string,
    stayId: string,
  ): Promise<readonly ServiceRequestSummary[]> {
    return this.tx.read(async () =>
      (await this.repo.ofStay({ tenantId }, stayId, null)).map(summary),
    );
  }
}
