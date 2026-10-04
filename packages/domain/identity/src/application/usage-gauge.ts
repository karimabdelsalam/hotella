import { Inject, Injectable, type OnModuleInit, Optional } from '@nestjs/common';
import { USAGE_GAUGES, type UsageGaugeRegistrar } from '@hotella/domain-licensing/public';
import { IdentityRepositories } from '../infrastructure/repositories';

/** Spec §61 ACTIVE_STAFF: the licensing context samples it daily; this context owns the count. */
@Injectable()
export class IdentityUsageGauge implements OnModuleInit {
  constructor(
    private readonly repo: IdentityRepositories,
    @Optional() @Inject(USAGE_GAUGES) private readonly gauges?: UsageGaugeRegistrar,
  ) {}
  onModuleInit(): void {
    this.gauges?.register({
      metric: 'ACTIVE_STAFF',
      sample: async (tenantId) => [
        { propertyId: null, value: await this.repo.countLiveStaff({ tenantId }) },
      ],
    });
  }
}
