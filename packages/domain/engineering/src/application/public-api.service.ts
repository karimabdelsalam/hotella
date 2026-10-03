import { Injectable } from '@nestjs/common';
import { isUuid, TransactionRunner } from '@hotella/platform-database';
import { EngineeringRepositories } from '../infrastructure/repositories';
import type { AssetRow } from '../infrastructure/schema';
import type { AssetSummary, EngineeringPublicApi } from '../public';

function summary(a: AssetRow): AssetSummary {
  return {
    id: a.id,
    propertyId: a.propertyId,
    assetNumber: a.assetNumber,
    name: a.name,
    assetTypeId: a.assetTypeId,
    assetModelId: a.assetModelId,
    locationId: a.locationId,
    status: a.status,
    criticality: a.criticality,
    warrantyUntil: a.warrantyUntil,
  };
}

@Injectable()
export class EngineeringPublicApiService implements EngineeringPublicApi {
  constructor(
    private readonly repo: EngineeringRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  getAsset(tenantId: string, propertyId: string, assetId: string): Promise<AssetSummary | null> {
    return this.tx.read(async () => {
      const a = isUuid(assetId) ? await this.repo.asset({ tenantId }, assetId) : undefined;
      return a && a.propertyId === propertyId ? summary(a) : null;
    });
  }

  activeRestriction(tenantId: string, propertyId: string, roomId: string) {
    return this.tx.read(async () => {
      const r = isUuid(roomId)
        ? await this.repo.openRestriction({ tenantId, propertyId }, roomId)
        : undefined;
      return r ? { id: r.id, kind: r.kind } : null;
    });
  }

  assetsAtLocation(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<readonly AssetSummary[]> {
    return this.tx.read(async () =>
      (await this.repo.assetsOf({ tenantId, propertyId }, { locationIds: [locationId] }))
        .filter((a) => a.status === 'ACTIVE')
        .map(summary),
    );
  }
}
