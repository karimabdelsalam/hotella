import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { USAGE_GAUGES, type UsageGaugeRegistrar } from '@hotella/domain-licensing/public';
import { OrganizationRepositories } from '../infrastructure/repositories';

/** Spec §61 ACTIVE_PROPERTIES: the licensing context samples it daily; this context owns the count. */
@Injectable()
export class OrganizationUsageGauge implements OnModuleInit {
  constructor(
    private readonly repo: OrganizationRepositories,
    @Optional() @Inject(USAGE_GAUGES) private readonly gauges?: UsageGaugeRegistrar,
  ) {}
  onModuleInit(): void {
    this.gauges?.register({
      metric: 'ACTIVE_PROPERTIES',
      sample: async (tenantId) => [
        { propertyId: null, value: await this.repo.countLiveProperties({ tenantId }) },
      ],
    });
  }
}
