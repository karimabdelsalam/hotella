import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import { ActivationController, ChannelsController, RoomQrController } from './api/controllers';
import { GuestActivationController, GuestSelfController } from './api/guest.controllers';
import { GuestSessionGuard } from './api/guest-session.guard';
import { ActivationAdminService, RoomQrAdminService } from './application/activation-admin.service';
import { ActivationService } from './application/activation.service';
import { ArrivalActivation } from './application/arrival-activation';
import { ChannelAdminService, ChannelRuntime } from './application/channel.service';
import { GuestLifecycleConsumer } from './application/guest-lifecycle';
import { GuestPortalService } from './application/guest-portal.service';
import { ChannelIdentityService } from './application/identity.service';
import { OtpKeyring, OtpSender } from './application/otp-delivery';
import { ChannelAdapterRegistry } from './application/providers';
import { COMMUNICATIONS_SETTINGS } from './domain/settings';
import { ActivationRepositories } from './infrastructure/activation-repositories';
import { CommsRepositories } from './infrastructure/repositories';
import { COMMUNICATIONS_MANIFEST } from './manifest';

/** Inbox consumer names: one exactly-once effect per event. */
export const GUEST_LIFECYCLE_CONSUMER = 'comms.guest-lifecycle';
export const ARRIVAL_ACTIVATION_CONSUMER = 'comms.arrival-activation';
/** Repeatable job of the worker: automatic OTP fallback when no delivery receipt arrives (ADR-0015). */
export const OTP_FALLBACK_JOB = 'comms.otp.fallback';
const OTP_FALLBACK_EVERY_MS = 5_000;

/**
 * The communications context without HTTP routes: repositories, the adapter registry, channel runtime, identities,
 * OTP delivery and activation. Global so adapters (and tests' fakes) register into the one registry.
 */
@Global()
@Module({
  providers: [
    CommsRepositories,
    ActivationRepositories,
    ChannelAdapterRegistry,
    ChannelRuntime,
    ChannelIdentityService,
    OtpKeyring,
    OtpSender,
    ActivationService,
    ArrivalActivation,
    GuestLifecycleConsumer,
  ],
  exports: [
    CommsRepositories,
    ActivationRepositories,
    ChannelAdapterRegistry,
    ChannelRuntime,
    ChannelIdentityService,
    OtpKeyring,
    OtpSender,
    ActivationService,
    ArrivalActivation,
    GuestLifecycleConsumer,
  ],
})
export class CommunicationsCoreModule {}

/** Staff and guest API, settings and manifest, for the API process. */
@Module({
  imports: [CommunicationsCoreModule],
  controllers: [
    ChannelsController,
    ActivationController,
    RoomQrController,
    GuestActivationController,
    GuestSelfController,
  ],
  providers: [
    ChannelAdminService,
    ActivationAdminService,
    RoomQrAdminService,
    GuestPortalService,
    GuestSessionGuard,
  ],
})
export class CommunicationsModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(COMMUNICATIONS_MANIFEST);
    this.settings.register(...COMMUNICATIONS_SETTINGS);
  }
}

/**
 * Worker side: follows guest events (anonymization removes contact points, arrival sends the activation link to a
 * verified number) and runs the automatic OTP fallback every 5 s on `critical-operational`.
 */
@Module({ imports: [CommunicationsCoreModule] })
export class CommunicationsWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueRegistry,
    private readonly consumers: EventConsumerRegistry,
    private readonly lifecycle: GuestLifecycleConsumer,
    private readonly arrival: ArrivalActivation,
    private readonly activation: ActivationService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const def of GuestLifecycleConsumer.consumes)
      this.consumers.on(def.name, GUEST_LIFECYCLE_CONSUMER, (envelope) =>
        this.lifecycle.apply(envelope),
      );
    for (const def of ArrivalActivation.consumes)
      this.consumers.on(def.name, ARRIVAL_ACTIVATION_CONSUMER, (envelope) =>
        this.arrival.apply(envelope),
      );
    this.consumers.onJob(OTP_FALLBACK_JOB, async () => {
      await this.activation.sweepFallbacks();
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('critical-operational').upsertJobScheduler(
      OTP_FALLBACK_JOB,
      { every: OTP_FALLBACK_EVERY_MS },
      {
        name: OTP_FALLBACK_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
    this.logger.info(
      { job: OTP_FALLBACK_JOB, every_ms: OTP_FALLBACK_EVERY_MS },
      'communications schedule armed',
    );
  }
}
