export {
  ARRIVAL_ACTIVATION_CONSUMER,
  CommunicationsCoreModule,
  CommunicationsModule,
  CommunicationsWorkerModule,
  GUEST_LIFECYCLE_CONSUMER,
  OTP_FALLBACK_JOB,
} from './communications.module';
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
