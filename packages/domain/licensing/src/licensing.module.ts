import { Global, Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { ENTITLEMENT_STAGE } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import {
  BundleKeyController,
  ControlPlaneController,
  InstallationController,
  SiteBundleController,
  LicenseCatalogController,
  MyEntitlementsController,
  TenantLicenseController,
  TenantOwnLicenseController,
} from './api/controllers';
import { LicenseCatalogService } from './application/catalog.service';
import { EntitlementEngine } from './application/entitlement-engine';
import { EntitlementStage } from './application/entitlement-stage';
import { BundleKeys, InstallationService } from './application/installation.service';
import { SiteBundleStore } from './application/site-bundle.store';
import { InstallationRepositories } from './infrastructure/installation-repositories';
import { GrantService } from './application/grant.service';
import { LicenseViewService } from './application/license-view.service';
import { PlanService } from './application/plan.service';
import { SubscriptionService } from './application/subscription.service';
import { UsageService } from './application/usage.service';
import { ControlPlaneService } from './application/control.service';
import { WhiteLabelSweep } from './application/white-label.sweep';
import { AttributionPolicyService } from '@hotella/platform-settings';
import { UsageRepositories } from './infrastructure/usage-repositories';
import { CatalogRepositories } from './infrastructure/repositories';
import { TenantLicenseRepositories } from './infrastructure/tenant-repositories';
import { LICENSING_MANIFEST } from './manifest';
import { ENTITLEMENT_API, USAGE_API, USAGE_GAUGES } from './public';

/**
 * Licensing without HTTP routes (API and worker): the catalog sync, the entitlement engine (`ENTITLEMENT_API` for
 * other contexts) and the services behind the control plane.
 */
@Global()
@Module({
  providers: [
    CatalogRepositories,
    TenantLicenseRepositories,
    InstallationRepositories,
    SiteBundleStore,
    LicenseCatalogService,
    PlanService,
    EntitlementEngine,
    { provide: ENTITLEMENT_API, useExisting: EntitlementEngine },
    SubscriptionService,
    GrantService,
    LicenseViewService,
    UsageRepositories,
    UsageService,
    { provide: USAGE_API, useExisting: UsageService },
    { provide: USAGE_GAUGES, useExisting: UsageService },
  ],
  exports: [
    CatalogRepositories,
    TenantLicenseRepositories,
    InstallationRepositories,
    SiteBundleStore,
    LicenseCatalogService,
    PlanService,
    EntitlementEngine,
    ENTITLEMENT_API,
    SubscriptionService,
    GrantService,
    LicenseViewService,
    UsageService,
    USAGE_API,
    USAGE_GAUGES,
  ],
})
export class LicensingCoreModule {
  /** `AuthModule.forRoot({ stages: [LicensingCoreModule.entitlementStage()] })` — action-gate stage 2 (Spec §60). */
  static entitlementStage(): Provider {
    return {
      provide: ENTITLEMENT_STAGE,
      inject: [EntitlementEngine, ManifestRegistry],
      useFactory: (engine: EntitlementEngine, manifests: ManifestRegistry) =>
        new EntitlementStage(engine, manifests),
    };
  }
}

/** Control-plane and tenant routes and the manifest, for the API process. */
@Module({
  imports: [LicensingCoreModule],
  providers: [ControlPlaneService, BundleKeys, InstallationService],
  controllers: [
    ControlPlaneController,
    InstallationController,
    BundleKeyController,
    SiteBundleController,
    LicenseCatalogController,
    TenantLicenseController,
    TenantOwnLicenseController,
    MyEntitlementsController,
  ],
})
export class LicensingModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(LICENSING_MANIFEST);
  }
}

export const USAGE_GAUGES_JOB = 'license.usage.gauges';
export const USAGE_PURGE_JOB = 'license.usage.purge';
export const WHITE_LABEL_JOB = 'license.white_label.sweep';
export const BUNDLE_RENEW_JOB = 'license.bundle.renew';

/**
 * Worker side: the daily gauge samples (checked hourly, once per day), the retention of usage events and the daily
 * white-label check (the worker composes settings without routes, so the attribution service is provided here).
 */
@Module({ imports: [LicensingCoreModule], providers: [AttributionPolicyService, WhiteLabelSweep] })
export class LicensingWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly usage: UsageService,
    private readonly whiteLabel: WhiteLabelSweep,
    private readonly site: SiteBundleStore,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    this.consumers.onJob(WHITE_LABEL_JOB, async () => {
      await this.whiteLabel.run();
    });
    this.consumers.onJob(USAGE_GAUGES_JOB, async () => {
      const n = await this.usage.sampleGauges();
      if (n > 0) this.logger.info({ samples: n }, 'usage gauges sampled');
    });
    this.consumers.onJob(USAGE_PURGE_JOB, async () => {
      const n = await this.usage.purgeEvents();
      if (n > 0) this.logger.info({ purged: n }, 'usage events past retention purged');
    });
    this.consumers.onJob(BUNDLE_RENEW_JOB, async () => {
      await this.site.renew();
    });
    if (!this.config.worker.schedulerEnabled) return;
    if (this.config.licensing.mode === 'site') {
      // A hotel-site installation renews its signed entitlement bundle now and every few hours (ADR-0021).
      void this.site.renew();
      await this.queues.queue('normal').upsertJobScheduler(
        BUNDLE_RENEW_JOB,
        { every: this.config.licensing.renewHours * 3_600_000 },
        {
          name: BUNDLE_RENEW_JOB,
          data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
          opts: { removeOnComplete: 10, removeOnFail: 50 },
        },
      );
    }
    for (const [job, every] of [
      [USAGE_GAUGES_JOB, 3_600_000],
      [USAGE_PURGE_JOB, 86_400_000],
      [WHITE_LABEL_JOB, 86_400_000],
    ] as const)
      await this.queues.queue('normal').upsertJobScheduler(
        job,
        { every },
        {
          name: job,
          data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
          opts: { removeOnComplete: 10, removeOnFail: 50 },
        },
      );
    this.logger.info(
      { jobs: [USAGE_GAUGES_JOB, USAGE_PURGE_JOB, WHITE_LABEL_JOB] },
      'licensing schedule armed',
    );
  }
}
