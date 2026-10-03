import { Injectable } from '@nestjs/common';
import { isUuid, TransactionRunner } from '@hotella/platform-database';
import { RequestRepositories } from './infrastructure/request-repositories';
import { ServiceRequestService, summary } from './application/request.service';
import type {
  CatalogPublicApi,
  CreatedServiceRequest,
  CreateServiceRequestInput,
  ServiceRequestSummary,
} from './public';

@Injectable()
export class CatalogPublicApiService implements CatalogPublicApi {
  constructor(
    private readonly requests: ServiceRequestService,
    private readonly repo: RequestRepositories,
    private readonly tx: TransactionRunner,
  ) {}

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
