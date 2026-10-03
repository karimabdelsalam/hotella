import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '@hotella/platform-database';
import { LostFoundRepositories } from '../infrastructure/repositories';
import type { LostFoundPublicApi } from '../public';

@Injectable()
export class LostFoundPublicApiService implements LostFoundPublicApi {
  constructor(
    private readonly repo: LostFoundRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  openCounts(tenantId: string, propertyId: string) {
    return this.tx.read(async () => {
      const scope = { tenantId, propertyId };
      const open = await this.repo.itemsOf(scope, { statuses: ['REGISTERED', 'MATCHED'] });
      const today = new Date().toISOString().slice(0, 10);
      return {
        found: open.filter((i) => i.kind === 'FOUND').length,
        lost: open.filter((i) => i.kind === 'LOST').length,
        proposedMatches: (await this.repo.proposedMatches(scope)).length,
        retentionDue: open.filter(
          (i) => i.kind === 'FOUND' && !!i.retentionUntil && i.retentionUntil <= today,
        ).length,
      };
    });
  }
}
