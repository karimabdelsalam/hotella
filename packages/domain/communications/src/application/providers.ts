import { Injectable } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Channel adapters (Spec §18.1, ADR-0015). Domain code never talks to a vendor: a `comms.channels` row binds a property
 * channel to one adapter by `provider_code`, with adapter-specific configuration (validated by the adapter's schema)
 * and a `credential_ref` resolved through the SecretProvider (CLAUDE.md rules 13, 18).
 */

export type ChannelType =
  | 'WHATSAPP'
  | 'SMS'
  | 'EMAIL'
  | 'GUEST_WEB'
  | 'ROOM_QR'
  | 'VOICE'
  | 'MESSENGER'
  | 'INSTAGRAM'
  | 'APP';

export type MessageKind =
  'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | 'INTERACTIVE' | 'SYSTEM';

export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/** What an adapter gets for one call: the channel's validated configuration and lazy access to its credentials. */
export interface ProviderContext {
  readonly channelId: string;
  readonly tenantId: string;
  readonly propertyId: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Resolves the channel's credential (the SecretRef in `credential_ref`); never logged or stored. */
  readonly credential: () => Promise<string>;
}

export interface SendResult {
  readonly providerMessageId: string;
}

/**
 * A provider refused or could not be reached. `code` drives the deterministic fallback and channel health
 * (ADR-0015); vendor messages are not kept (they can echo the recipient).
 */
export class ProviderError extends Error {
  constructor(
    readonly code:
      'UNAVAILABLE' | 'TIMEOUT' | 'AUTH_FAILED' | 'INVALID_RECIPIENT' | 'RATE_LIMITED' | 'REJECTED',
    readonly retryable: boolean,
  ) {
    super(`provider error: ${code}`);
    this.name = 'ProviderError';
  }
}

/** A template message (OTP, activation link): the only kind allowed outside the 24-hour customer window. */
export interface TemplateMessage {
  readonly to: string;
  /** Platform template code (`otp`, `activation`); the adapter maps it to the provider's template id. */
  readonly template: string;
  readonly locale: string;
  readonly parameters: readonly string[];
}

export interface TextMessage {
  readonly to: string;
  readonly body: string;
  readonly replyToProviderMessageId?: string | null;
}

/** Normalized webhook content; raw vendor payloads never leave the adapter as domain events (rule 6). */
export type InboundItem =
  | {
      readonly kind: 'MESSAGE';
      readonly providerMessageId: string;
      readonly from: string;
      readonly at: Date;
      readonly type: MessageKind;
      readonly text: string | null;
      /** Provider media id; the media itself is fetched on demand, never trusted as an instruction. */
      readonly mediaRef: string | null;
      readonly replyToProviderMessageId: string | null;
    }
  | {
      readonly kind: 'STATUS';
      readonly providerMessageId: string;
      readonly status: Exclude<DeliveryStatus, 'QUEUED'>;
      readonly at: Date;
      readonly errorCode: string | null;
    };

export interface WebhookRequest {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Normalized voice gateway events (Planova Voice Profile v1, BUILD_PLAN 13.4). An utterance carries text or audio; the
 * audio is transcribed at the webhook and dropped, never stored (Q23).
 */
export type VoiceEvent =
  | {
      readonly kind: 'CALL_STARTED';
      readonly callId: string;
      readonly from: string;
      readonly to: string;
      readonly at: Date;
    }
  | {
      readonly kind: 'UTTERANCE';
      readonly callId: string;
      readonly utteranceId: string;
      readonly at: Date;
      readonly text: string | null;
      readonly audio: { readonly data: Uint8Array; readonly mimeType: string } | null;
      readonly language: string | null;
    }
  | {
      readonly kind: 'CALL_ENDED';
      readonly callId: string;
      readonly at: Date;
      readonly durationSeconds: number;
    };

interface AdapterCore {
  /** `WHATSAPP_META_CLOUD`, `WHATSAPP_BSP_360DIALOG`, `SMS_HTTP_GENERIC`, … */
  readonly code: string;
  readonly channelType: ChannelType;
  /** Validates `comms.channels.config` for this adapter on write and before every use. */
  readonly configSchema: z.ZodType<Record<string, unknown>>;
  verifyWebhook(ctx: ProviderContext, req: WebhookRequest): Promise<boolean>;
  /** Subscription handshake some providers perform before sending webhooks (Meta's `hub.verify_token`). */
  verifySubscription?(ctx: ProviderContext, token: string | undefined): Promise<boolean>;
}

interface AdapterBase extends AdapterCore {
  parseWebhook(ctx: ProviderContext, body: unknown): readonly InboundItem[];
}

/** WhatsApp and other conversational channels (ADR-0015 `MessagingProvider`). */
export interface MessagingProvider extends AdapterBase {
  readonly kind: 'MESSAGING';
  sendTemplate(ctx: ProviderContext, message: TemplateMessage): Promise<SendResult>;
  sendText(ctx: ProviderContext, message: TextMessage): Promise<SendResult>;
}

/** SMS aggregators (ADR-0015 `SmsProvider`): OTP fallback and delivery receipts. */
export interface SmsProvider extends AdapterBase {
  readonly kind: 'SMS';
  sendSms(
    ctx: ProviderContext,
    message: { readonly to: string; readonly text: string },
  ): Promise<SendResult>;
}

/**
 * A voice gateway (a PBX bridge or SIP service, owner decision Q21): it reports calls and utterances, speaks into a live
 * call and transfers it to an extension. Stateless like the messaging adapters.
 */
export interface VoiceProvider extends AdapterCore {
  readonly kind: 'VOICE';
  parseVoiceWebhook(ctx: ProviderContext, body: unknown): readonly VoiceEvent[];
  /** Speaks into the live call: text always, audio when a speech service synthesized it. */
  say(
    ctx: ProviderContext,
    message: {
      readonly callId: string;
      readonly text: string;
      readonly audio: { readonly data: Uint8Array; readonly mimeType: string } | null;
    },
  ): Promise<SendResult>;
  transfer(
    ctx: ProviderContext,
    call: { readonly callId: string; readonly extension: string },
  ): Promise<void>;
}

export type ChannelAdapter = MessagingProvider | SmsProvider | VoiceProvider;

/** Every adapter the running process knows; channels can only bind to registered codes. */
@Injectable()
export class ChannelAdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  register(...adapters: ChannelAdapter[]): void {
    for (const a of adapters) {
      const existing = this.adapters.get(a.code);
      if (existing && existing !== a)
        throw new Error(`Channel adapter "${a.code}" registered twice`);
      this.adapters.set(a.code, a);
    }
  }
  get(code: string): ChannelAdapter | undefined {
    return this.adapters.get(code);
  }
  codes(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
