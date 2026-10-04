import { Injectable } from '@nestjs/common';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { AttributionPolicyService } from '@hotella/platform-settings';
import { WHITE_LABEL } from './control.service';
import { EntitlementEngine } from './entitlement-engine';

/**
 * CLAUDE.md rule 15: "Powered by Planova" stays hidden only while the tenant holds WHITE_LABEL. Daily, a tenant whose
 * entitlement ended (subscription lapsed, grant revoked or expired) shows it again — system work, audited.
 */
@Injectable()
export class WhiteLabelSweep {
  constructor(
    private readonly engine: EntitlementEngine,
    private readonly attribution: AttributionPolicyService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async run(): Promise<number> {
    let restored = 0;
    for (const tenantId of await this.attribution.hiddenTenants()) {
      if (await this.engine.can(tenantId, null, WHITE_LABEL)) continue;
      if (await this.attribution.restore(tenantId, 'white-label entitlement ended')) restored++;
    }
    if (restored) this.logger.info({ restored }, 'attribution restored after white-label ended');
    return restored;
  }
}
