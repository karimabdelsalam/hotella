import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { ChannelsController } from './api/controllers';
import { ChannelAdminService, ChannelRuntime } from './application/channel.service';
import { GuestLifecycleConsumer } from './application/guest-lifecycle';
import { ChannelIdentityService } from './application/identity.service';
import { ChannelAdapterRegistry } from './application/providers';
import { CommsRepositories } from './infrastructure/repositories';
import { COMMUNICATIONS_MANIFEST } from './manifest';

/** Inbox consumer name: one exactly-once effect per guest event. */
export const GUEST_LIFECYCLE_CONSUMER = 'comms.guest-lifecycle';

/**
 * The communications context without HTTP routes: repositories, the adapter registry, channel runtime and identities.
 * Global so adapters (and tests' fakes) register into the one registry.
 */
@Global()
@Module({
  providers: [
    CommsRepositories,
    ChannelAdapterRegistry,
    ChannelRuntime,
    ChannelIdentityService,
    GuestLifecycleConsumer,
  ],
  exports: [
    CommsRepositories,
    ChannelAdapterRegistry,
    ChannelRuntime,
    ChannelIdentityService,
    GuestLifecycleConsumer,
  ],
})
export class CommunicationsCoreModule {}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [CommunicationsCoreModule],
  controllers: [ChannelsController],
  providers: [ChannelAdminService],
})
export class CommunicationsModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(COMMUNICATIONS_MANIFEST);
  }
}

/** Worker side: follows guest events (anonymization removes contact points). */
@Module({ imports: [CommunicationsCoreModule] })
export class CommunicationsWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly lifecycle: GuestLifecycleConsumer,
  ) {}
  onModuleInit(): void {
    for (const def of GuestLifecycleConsumer.consumes)
      this.consumers.on(def.name, GUEST_LIFECYCLE_CONSUMER, (envelope) =>
        this.lifecycle.apply(envelope),
      );
  }
}
