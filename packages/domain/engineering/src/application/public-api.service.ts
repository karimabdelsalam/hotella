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

  activeRestrictions(tenantId: string, propertyId: string) {
    return this.tx.read(async () =>
      (await this.repo.openRestrictions({ tenantId, propertyId })).map((r) => ({
        roomId: r.roomId,
        kind: r.kind,
        since: r.startsAt.toISOString(),
      })),
    );
  }

  recentCorrectiveWork(tenantId: string, propertyId: string, locationId: string, days: number) {
    return this.tx.read(async () => {
      if (!isUuid(locationId)) return { count: 0, assetIds: [] };
      const rows = await this.repo.correctiveDoneSince(
        { tenantId, propertyId },
        locationId,
        new Date(Date.now() - days * 86_400_000),
      );
      return {
        count: rows.length,
        assetIds: [...new Set(rows.flatMap((r) => (r.assetId ? [r.assetId] : [])))],
      };
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
