import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import {
  ActivationController,
  CallsController,
  ChannelsController,
  VoiceDirectoryController,
  InboxController,
  RoomQrController,
} from './api/controllers';
import {
  GuestActivationController,
  GuestChatController,
  GuestSelfController,
} from './api/guest.controllers';
import { WebhooksController } from './api/webhooks.controller';
import { RealtimeGateway } from './api/realtime.gateway';
import { RealtimeRelay } from './application/realtime-relay';
import { Dialog360WhatsAppAdapter } from './application/adapters/bsp';
import { MetaCloudWhatsAppAdapter } from './application/adapters/meta-cloud';
import { JsonHttpSmsAdapter } from './application/adapters/sms-http';
import { VoiceGatewayAdapter } from './application/adapters/voice-gateway';
import { SpeechRegistry } from './application/speech';
import { VoiceService } from './application/voice.service';
import { VoiceDirectoryService } from './application/voice-directory.service';
import { CallRepositories } from './infrastructure/call-repositories';
import { ConversationService } from './application/conversation.service';
import { InboxService } from './application/inbox.service';
import { ConversationRepositories } from './infrastructure/conversation-repositories';
import { GuestSessionGuard } from '@hotella/domain-guest/public';
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
import { COMMUNICATIONS_API, SPEECH_SERVICES } from './public';

/** Inbox consumer names: one exactly-once effect per event. */
export const GUEST_LIFECYCLE_CONSUMER = 'comms.guest-lifecycle';
export const ARRIVAL_ACTIVATION_CONSUMER = 'comms.arrival-activation';
export const CONVERSATION_LIFECYCLE_CONSUMER = 'comms.conversation-lifecycle';
export const REALTIME_RELAY_CONSUMER = 'comms.realtime-relay';
/** A hand-off during a live call transfers it to the operator (BUILD_PLAN 13.4). */
export const VOICE_HANDOFF_CONSUMER = 'comms.voice-handoff';
/** Repeatable jobs: queued replies leave through their channel; webhook items left unprocessed are retried. */
export const MESSAGE_SEND_JOB = 'comms.message.send';
export const INBOUND_RETRY_JOB = 'comms.inbound.retry';
const MESSAGE_SEND_EVERY_MS = 3_000;
const INBOUND_RETRY_EVERY_MS = 15_000;
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
    ConversationRepositories,
    ChannelAdapterRegistry,
    ChannelRuntime,
    ChannelIdentityService,
    OtpKeyring,
    OtpSender,
    ActivationService,
    ArrivalActivation,
    GuestLifecycleConsumer,
    ConversationService,
    { provide: COMMUNICATIONS_API, useExisting: ConversationService },
    CallRepositories,
    SpeechRegistry,
    { provide: SPEECH_SERVICES, useExisting: SpeechRegistry },
    VoiceService,
  ],
  exports: [
    COMMUNICATIONS_API,
    CallRepositories,
    SpeechRegistry,
    SPEECH_SERVICES,
    VoiceService,
    CommsRepositories,
    ActivationRepositories,
    ConversationRepositories,
    ChannelAdapterRegistry,
    ChannelRuntime,
    ChannelIdentityService,
    OtpKeyring,
    OtpSender,
    ActivationService,
    ArrivalActivation,
    GuestLifecycleConsumer,
    ConversationService,
  ],
})
export class CommunicationsCoreModule implements OnModuleInit {
  constructor(private readonly adapters: ChannelAdapterRegistry) {}
  /** The shipped provider adapters (ADR-0015); tests and local development add the fakes. */
  onModuleInit(): void {
    this.adapters.register(
      new MetaCloudWhatsAppAdapter(),
      new Dialog360WhatsAppAdapter(),
      new JsonHttpSmsAdapter(),
      new VoiceGatewayAdapter(),
    );
  }
}

/** Staff and guest API, settings and manifest, for the API process. */
@Module({
  imports: [CommunicationsCoreModule],
  controllers: [
    ChannelsController,
    ActivationController,
    RoomQrController,
    InboxController,
    CallsController,
    VoiceDirectoryController,
    GuestActivationController,
    GuestSelfController,
    GuestChatController,
    WebhooksController,
  ],
  providers: [
    ChannelAdminService,
    ActivationAdminService,
    RoomQrAdminService,
    GuestPortalService,
    GuestSessionGuard,
    InboxService,
    VoiceDirectoryService,
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
 * verified number, check-out closes the stay's conversation, anonymization clears message texts) and runs the OTP
 * fallback (5 s), outbound messages (3 s) and the retry of unprocessed webhook items (15 s).
 */
@Module({ imports: [CommunicationsCoreModule], providers: [RealtimeRelay] })
export class CommunicationsWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueRegistry,
    private readonly consumers: EventConsumerRegistry,
    private readonly lifecycle: GuestLifecycleConsumer,
    private readonly arrival: ArrivalActivation,
    private readonly activation: ActivationService,
    private readonly conversations: ConversationService,
    private readonly relay: RealtimeRelay,
    private readonly voice: VoiceService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const def of RealtimeRelay.consumes)
      this.consumers.on(def.name, REALTIME_RELAY_CONSUMER, (envelope) =>
        this.relay.apply(envelope),
      );
    for (const def of GuestLifecycleConsumer.consumes)
      this.consumers.on(def.name, GUEST_LIFECYCLE_CONSUMER, (envelope) =>
        this.lifecycle.apply(envelope),
      );
    for (const def of ArrivalActivation.consumes)
      this.consumers.on(def.name, ARRIVAL_ACTIVATION_CONSUMER, (envelope) =>
        this.arrival.apply(envelope),
      );
    for (const def of ConversationService.consumes)
      this.consumers.on(def.name, CONVERSATION_LIFECYCLE_CONSUMER, (envelope) =>
        this.conversations.apply(envelope),
      );
    for (const def of VoiceService.consumes)
      this.consumers.on(def.name, VOICE_HANDOFF_CONSUMER, (envelope) => this.voice.apply(envelope));
    this.consumers.onJob(OTP_FALLBACK_JOB, async () => {
      await this.activation.sweepFallbacks();
    });
    this.consumers.onJob(MESSAGE_SEND_JOB, async () => {
      await this.conversations.sendDue();
    });
    this.consumers.onJob(INBOUND_RETRY_JOB, async () => {
      await this.conversations.sweepInbound();
    });
    if (!this.config.worker.schedulerEnabled) return;
    for (const [job, every, queue] of [
      [OTP_FALLBACK_JOB, OTP_FALLBACK_EVERY_MS, 'critical-operational'],
      [MESSAGE_SEND_JOB, MESSAGE_SEND_EVERY_MS, 'guest-realtime'],
      [INBOUND_RETRY_JOB, INBOUND_RETRY_EVERY_MS, 'normal'],
    ] as const) {
      await this.queues.queue(queue).upsertJobScheduler(
        job,
        { every },
        {
          name: job,
          data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
          opts: { removeOnComplete: 10, removeOnFail: 50 },
        },
      );
      this.logger.info({ job, every_ms: every }, 'communications schedule armed');
    }
  }
}

/**
 * The realtime gateway for the API process (notes for 4.4): WebSocket on `/api/v1/realtime`, fed by the worker's
 * relay over Valkey pub/sub. Needs the queue module (Valkey) and the auth module (strategy, permissions).
 */
@Module({
  imports: [CommunicationsCoreModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class CommunicationsRealtimeModule {}
