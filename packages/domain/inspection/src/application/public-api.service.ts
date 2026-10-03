import { Injectable } from '@nestjs/common';
import { isUuid, TransactionRunner } from '@hotella/platform-database';
import { InspectionRepositories } from '../infrastructure/repositories';
import type { InspectionRow } from '../infrastructure/schema';
import type { InspectionPublicApi, InspectionSummary } from '../public';

function summary(r: InspectionRow): InspectionSummary {
  return {
    id: r.id,
    propertyId: r.propertyId,
    number: r.number,
    locationId: r.locationId,
    assetId: r.assetId,
    status: r.status,
    result: r.result,
    score: r.score,
    completedAt: r.completedAt?.toISOString() ?? null,
    source: r.source,
    sourceRef: r.sourceRef,
  };
}

@Injectable()
export class InspectionPublicApiService implements InspectionPublicApi {
  constructor(
    private readonly repo: InspectionRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  getInspection(tenantId: string, inspectionId: string) {
    return this.tx.read(async () => {
      const r = isUuid(inspectionId)
        ? await this.repo.inspection({ tenantId }, inspectionId)
        : undefined;
      return r ? summary(r) : null;
    });
  }

  latestCompletedAt(tenantId: string, propertyId: string, locationId: string) {
    return this.tx.read(async () => {
      const r = await this.repo.latestCompletedAt({ tenantId, propertyId }, locationId);
      return r ? summary(r) : null;
    });
  }
}
