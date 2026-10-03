import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '@hotella/platform-database';
import { RelationsRepositories } from '../infrastructure/repositories';
import type { RelationsPublicApi } from '../public';

@Injectable()
export class RelationsPublicApiService implements RelationsPublicApi {
  constructor(
    private readonly repo: RelationsRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  openComplaints(tenantId: string, propertyId: string) {
    return this.tx.read(async () => {
      const scope = { tenantId, propertyId };
      const rows = await this.repo.complaintsOf(scope, { statuses: ['OPEN', 'IN_PROGRESS'] });
      const codes = new Map((await this.repo.categoriesOf(scope)).map((c) => [c.id, c.code]));
      return rows.map((r) => ({
        id: r.id,
        number: r.number,
        categoryCode: codes.get(r.categoryId) ?? '',
        severity: r.severity,
        status: r.status as 'OPEN' | 'IN_PROGRESS',
        stayId: r.stayId,
        openedAt: r.openedAt.toISOString(),
      }));
    });
  }
}
