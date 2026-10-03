export {
  ARRIVAL_ACTIVATION_CONSUMER,
  CommunicationsCoreModule,
  CommunicationsModule,
  CommunicationsRealtimeModule,
  CommunicationsWorkerModule,
  REALTIME_RELAY_CONSUMER,
  GUEST_LIFECYCLE_CONSUMER,
  CONVERSATION_LIFECYCLE_CONSUMER,
  INBOUND_RETRY_JOB,
  MESSAGE_SEND_JOB,
  OTP_FALLBACK_JOB,
} from './communications.module';
export { ConversationService } from './application/conversation.service';
export { MetaCloudWhatsAppAdapter } from './application/adapters/meta-cloud';
export { CloudCompatibleBspAdapter, Dialog360WhatsAppAdapter } from './application/adapters/bsp';
export { JsonHttpSmsAdapter } from './application/adapters/sms-http';
export { ActivationService } from './application/activation.service';
export { ArrivalActivation } from './application/arrival-activation';
export { OtpKeyring } from './application/otp-delivery';
export { GUEST_SESSION_HEADER } from './api/guest-session.guard';
export { ChannelRuntime } from './application/channel.service';
export { ChannelIdentityService } from './application/identity.service';
export { GuestLifecycleConsumer } from './application/guest-lifecycle';
export { ChannelAdapterRegistry, ProviderError } from './application/providers';
export type {
  ChannelAdapter,
  ChannelType,
  DeliveryStatus,
  InboundItem,
  MessageKind,
  MessagingProvider,
  ProviderContext,
  SendResult,
  SmsProvider,
  TemplateMessage,
  TextMessage,
  WebhookRequest,
} from './application/providers';
export { FakeSmsProvider, FakeWhatsAppProvider } from './application/fake-providers';
export type { FakeSent } from './application/fake-providers';
export { isE164, maskPhone, toE164 } from './domain/phone';
export * from './public';
export * as communicationsSchema from './infrastructure/schema';
export { RealtimeGateway } from './api/realtime.gateway';
export { REALTIME_CHANNEL_PREFIX, RealtimeRelay } from './application/realtime-relay';
export type { RealtimeNotice } from './application/realtime-relay';
