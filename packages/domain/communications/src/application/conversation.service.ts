import { Inject, Injectable, Optional } from '@nestjs/common';
import { USAGE_API, type UsagePublicApi } from '@hotella/domain-licensing/public';
import {
  ConversationOpened,
  DeliveryUpdated,
  HandoffRequested,
  type EventEnvelope,
  GuestAnonymized,
  MessageReceived,
  MessageSent,
  StayStatusChanged,
} from '@hotella/contracts-events';
import { GUEST_API, type GuestPrincipal, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { SettingsReader } from '@hotella/platform-settings';
import { isUuid, newId, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError, I18nService } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { COMMS_AI_MODE_DEFAULT } from '../domain/settings';
import { ConversationRepositories } from '../infrastructure/conversation-repositories';
import type {
  ChannelRow,
  ConversationRow,
  InboundEventRow,
  MessageRow,
} from '../infrastructure/schema';
import { CommsRepositories } from '../infrastructure/repositories';
import { CallRepositories } from '../infrastructure/call-repositories';
import { ActivationService } from './activation.service';
import { ChannelRuntime } from './channel.service';
import { ChannelIdentityService } from './identity.service';
import type {
  CommunicationsPublicApi,
  GuestNotificationInput,
  GuestNotificationResult,
  ConversationForAi,
  ConversationMessage,
} from '../public';
import { type InboundItem, ProviderError, type SendResult } from './providers';
import { SpeechRegistry } from './speech';

const COMMS = 'comms';
/** WhatsApp customer-service window: free-form replies only within 24 h of the guest's last message. */
export const REPLY_WINDOW_MS = 24 * 3_600_000;
const PROMPT_EVERY_MS = 24 * 3_600_000;
export const MAX_SEND_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];
const MAX_INBOUND_ATTEMPTS = 5;

type Sender = { type: 'GUEST' | 'STAFF' | 'AI' | 'SYSTEM'; ref: string | null };

/**
 * The Conversation Engine (Spec §18.1): channel adapters deliver normalized items; this engine stores them, routes
 * them to a conversation and queues replies. A phone number reaches a stay only through a verified identity *and* a
 * live grant with CHAT (Spec §18.3) — anyone else gets their own conversation and an activation prompt.
 */
@Injectable()
export class ConversationService implements CommunicationsPublicApi {
  constructor(
    private readonly repo: ConversationRepositories,
    private readonly comms: CommsRepositories,
    private readonly identities: ChannelIdentityService,
    private readonly activation: ActivationService,
    private readonly runtime: ChannelRuntime,
    private readonly events: EventPublisher,
    private readonly i18n: I18nService,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly settings: SettingsReader,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    private readonly calls: CallRepositories,
    private readonly speech: SpeechRegistry,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(USAGE_API) private readonly usage?: UsagePublicApi,
  ) {}

  // ---- inbound (webhooks) ----

  /** Stores each verified webhook item once, then processes it; failures stay RECEIVED for the worker's retry. */
  async ingest(channel: ChannelRow, items: readonly InboundItem[]): Promise<{ stored: number }> {
    const stored: InboundEventRow[] = [];
    await this.tx.run(async () => {
      for (const item of items) {
        const row = await this.repo.insertInbound({
          id: newId(),
          tenantId: channel.tenantId,
          propertyId: channel.propertyId,
          channelId: channel.id,
          providerEventId:
            item.kind === 'MESSAGE'
              ? `msg:${item.providerMessageId}`
              : `status:${item.providerMessageId}:${item.status}`,
          payload: item,
          receivedAt: new Date(),
        });
        if (row) stored.push(row);
      }
    });
    for (const row of stored) await this.process(row.tenantId, row.id);
    return { stored: stored.length };
  }

  /** Processes one stored item (idempotent: a processed row is skipped; SKIP LOCKED against the worker sweep). */
  async process(tenantId: string, id: string): Promise<void> {
    const scope = { tenantId };
    try {
      await this.tx.run(async () => {
        const row = await this.repo.inboundForUpdate(scope, id);
        if (!row) return;
        const channel = await this.comms.channelById(row.channelId);
        if (!channel) return;
        const item = revive(row.payload as InboundItem);
        if (item.kind === 'MESSAGE') await this.receive(channel, item);
        else await this.receipt(channel, item);
        await this.repo.finishInbound(scope, row.id, {
          status: 'PROCESSED',
          processedAt: new Date(),
        });
      });
    } catch (e) {
      await this.tx.run(async () => {
        const row = await this.repo.inboundForUpdate(scope, id);
        if (!row) return;
        const attempts = row.attempts + 1;
        await this.repo.finishInbound(scope, row.id, {
          attempts,
          errorCode: e instanceof AppError ? e.code.slice(0, 32) : 'ERROR',
          ...(attempts >= MAX_INBOUND_ATTEMPTS ? { status: 'FAILED' as const } : {}),
        });
      });
      this.logger.warn({ inbound_id: id, err: e }, 'inbound item not processed');
    }
  }

  /** Worker sweep: items left RECEIVED (a crash or an error during the webhook request) are retried. */
  async sweepInbound(now: Date = new Date(), limit = 200): Promise<number> {
    const pending = await this.repo.pendingInbound(new Date(now.getTime() - 10_000), limit);
    for (const p of pending) await this.process(p.tenantId, p.id);
    return pending.length;
  }

  private async receive(channel: ChannelRow, item: Extract<InboundItem, { kind: 'MESSAGE' }>) {
    if (channel.type !== 'WHATSAPP') return; // SMS is a code channel only; no conversations over SMS.
    const scope = { tenantId: channel.tenantId };
    const identity = await this.identities.observe(
      channel.tenantId,
      'WHATSAPP',
      item.from,
      item.at,
    );
    const verifiedGuest = identity.guestId && identity.verifiedAt ? identity.guestId : null;
    const grant = verifiedGuest
      ? await this.guests.liveGrantAtProperty(channel.tenantId, channel.propertyId, verifiedGuest)
      : null;
    const stayId = grant?.stayId && grant.effectiveScopes.includes('CHAT') ? grant.stayId : null;
    let conversation =
      (stayId
        ? await this.repo.openConversationOfStay(scope, stayId)
        : await this.repo.openConversationOfIdentity(
            { tenantId: channel.tenantId, propertyId: channel.propertyId },
            identity.id,
          )) ??
      (await this.open(channel, {
        guestId: verifiedGuest,
        stayId,
        identityId: identity.id,
        replyChannelType: 'WHATSAPP',
      }));
    const guest = await this.repo.participant(
      scope,
      conversation.id,
      'GUEST',
      verifiedGuest,
      item.at,
    );
    const message = await this.repo.insertMessage({
      id: newId(),
      tenantId: channel.tenantId,
      conversationId: conversation.id,
      channelId: channel.id,
      channelType: 'WHATSAPP',
      direction: 'INBOUND',
      senderParticipantId: guest.id,
      senderType: 'GUEST',
      senderRef: verifiedGuest,
      type: item.type,
      body: item.text,
      mediaRef: item.mediaRef,
      providerMessageId: item.providerMessageId,
      deliveryStatus: 'DELIVERED',
    });
    if (!message) return; // the same provider message twice
    // Replies go to whoever wrote last, on the channel they wrote on (also when the stay's conversation began on the
    // guest web or with another party member's number).
    conversation = await this.repo.updateConversation(scope, conversation.id, {
      replyChannelId: channel.id,
      replyChannelType: 'WHATSAPP',
      channelIdentityId: identity.id,
      lastMessageAt: item.at,
      lastInboundAt: item.at,
      ...(conversation.status === 'HANDED_OFF' ? {} : { status: 'WAITING_STAFF' as const }),
    });
    await this.announceReceived(conversation, message);
    if (!stayId) await this.promptActivation(conversation, item.at);
  }

  // ---- voice (BUILD_PLAN 13.4) ----

  /** The stay's open conversation for a trusted room-phone call; opened (on the VOICE channel) when there is none. */
  async conversationForCall(
    channel: ChannelRow,
    stay: { readonly id: string; readonly primaryGuestId: string },
    identityId: string,
  ): Promise<ConversationRow> {
    return (
      (await this.repo.openConversationOfStay({ tenantId: channel.tenantId }, stay.id)) ??
      (await this.open(channel, {
        guestId: stay.primaryGuestId,
        stayId: stay.id,
        identityId,
        replyChannelType: 'VOICE',
      }))
    );
  }

  /**
   * One transcribed utterance of a live call: a guest message on the VOICE channel (who of the party spoke is unknown,
   * so no sender guest). The WhatsApp window is not touched: a call does not open it.
   */
  async receiveUtterance(
    conversation: ConversationRow,
    channel: ChannelRow,
    input: { readonly providerMessageId: string; readonly text: string; readonly at: Date },
  ): Promise<boolean> {
    const scope = { tenantId: conversation.tenantId };
    const guest = await this.repo.participant(scope, conversation.id, 'GUEST', null, input.at);
    const message = await this.repo.insertMessage({
      id: newId(),
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      channelId: channel.id,
      channelType: 'VOICE',
      direction: 'INBOUND',
      senderParticipantId: guest.id,
      senderType: 'GUEST',
      senderRef: null,
      type: 'TEXT',
      body: input.text,
      mediaRef: null,
      providerMessageId: input.providerMessageId,
      deliveryStatus: 'DELIVERED',
    });
    if (!message) return false; // the same utterance twice
    const updated = await this.repo.updateConversation(scope, conversation.id, {
      lastMessageAt: input.at,
      ...(conversation.status === 'HANDED_OFF' ? {} : { status: 'WAITING_STAFF' as const }),
    });
    await this.announceReceived(updated, message);
    return true;
  }

  /** Speech for a voice reply when a speech service is registered; the gateway speaks the text itself otherwise. */
  private async voiceAudio(conversation: ConversationRow, text: string) {
    const port = this.speech.current();
    if (!port) return null;
    try {
      const spoken = await port.synthesize({
        tenantId: conversation.tenantId,
        propertyId: conversation.propertyId,
        text,
        language: null,
      });
      return { data: spoken.audio, mimeType: spoken.mimeType };
    } catch (err) {
      this.logger.warn({ conversation_id: conversation.id, err }, 'voice reply not synthesized');
      return null;
    }
  }

  /** "Verify first": one message per day to a contact without access, pointing to the link or the room QR. */
  private async promptActivation(conversation: ConversationRow, at: Date) {
    if (
      conversation.activationPromptedAt &&
      at.getTime() - conversation.activationPromptedAt.getTime() < PROMPT_EVERY_MS
    )
      return;
    const property = await this.org.getProperty(conversation.tenantId, conversation.propertyId);
    const locale = property?.defaultLocale ?? this.i18n.defaultLocale;
    await this.repo.updateConversation({ tenantId: conversation.tenantId }, conversation.id, {
      activationPromptedAt: at,
    });
    await this.queue(
      conversation,
      { type: 'SYSTEM', ref: null },
      this.i18n.t('comms.inbound.activation_prompt', { property: property?.name ?? '' }, locale),
      'TEXT',
    );
  }

  private async receipt(channel: ChannelRow, item: Extract<InboundItem, { kind: 'STATUS' }>) {
    const scope = { tenantId: channel.tenantId };
    const message = await this.repo.messageByProviderId(scope, channel.id, item.providerMessageId);
    if (!message) {
      // Not a conversation message: perhaps an OTP (verification deliveries keep their own receipts).
      await this.activation.deliveryStatus(
        channel.tenantId,
        channel.id,
        item.providerMessageId,
        item.status,
        item.at,
        item.errorCode,
      );
      return;
    }
    const moved = await this.repo.advanceDelivery(scope, message.id, item.status, item.errorCode);
    if (!moved) return;
    await this.repo.insertDeliveryEvent({
      id: newId(),
      tenantId: channel.tenantId,
      messageId: message.id,
      status: item.status,
      errorCode: item.errorCode,
      occurredAt: item.at,
    });
    await this.events.publish(DeliveryUpdated, {
      tenantId: channel.tenantId,
      propertyId: channel.propertyId,
      source: COMMS,
      aggregate: { type: 'message', id: message.id },
      payload: {
        conversation_id: message.conversationId,
        message_id: message.id,
        status: item.status,
        error_code: item.errorCode,
      },
    });
  }

  // ---- outbound ----

  /**
   * Queues a reply on the conversation's reply channel. Guest-web conversations need no provider: the message is shown
   * at once (and pushed by the realtime gateway).
   */
  async queue(
    conversation: ConversationRow,
    sender: Sender,
    body: string,
    type: MessageRow['type'] = 'TEXT',
  ): Promise<MessageRow> {
    const scope = { tenantId: conversation.tenantId };
    const now = new Date();
    const participant = await this.repo.participant(
      scope,
      conversation.id,
      sender.type,
      sender.ref,
      now,
    );
    const web = conversation.replyChannelType === 'GUEST_WEB' || !conversation.replyChannelId;
    const message = (await this.repo.insertMessage({
      id: newId(),
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      channelId: web ? null : conversation.replyChannelId,
      channelType: web ? 'GUEST_WEB' : conversation.replyChannelType,
      direction: 'OUTBOUND',
      senderParticipantId: participant.id,
      senderType: sender.type,
      senderRef: sender.ref,
      type,
      body,
      deliveryStatus: web ? 'SENT' : 'QUEUED',
      nextAttemptAt: web ? null : now,
    }))!;
    await this.repo.updateConversation(scope, conversation.id, { lastMessageAt: now });
    if (web) await this.announceSent(conversation, message);
    return message;
  }

  /** Worker job: sends due queued messages through their channel, with retries; never past the reply window. */
  async sendDue(now: Date = new Date(), limit = 100): Promise<number> {
    let sent = 0;
    for (const due of await this.repo.dueOutbound(now, limit)) {
      const done = await this.tx.run(async () => {
        const scope = { tenantId: due.tenantId };
        const message = await this.repo.claimOutbound(scope, due.id);
        if (!message) return false;
        const conversation = (await this.repo.conversation(scope, message.conversationId))!;
        const channel = message.channelId
          ? await this.comms.channelById(message.channelId)
          : undefined;
        const fail = async (code: string) => {
          await this.repo.updateMessage(scope, message.id, {
            deliveryStatus: 'FAILED',
            errorCode: code,
            nextAttemptAt: null,
          });
          await this.repo.insertDeliveryEvent({
            id: newId(),
            tenantId: message.tenantId,
            messageId: message.id,
            status: 'FAILED',
            errorCode: code,
            occurredAt: now,
          });
          return false;
        };
        if (!channel || channel.status !== 'ACTIVE') return fail('CHANNEL_UNAVAILABLE');
        // A voice reply is spoken into the conversation's live call on that channel, or not at all.
        const call =
          channel.type === 'VOICE'
            ? await this.calls.liveOfConversation(scope, conversation.id)
            : undefined;
        if (channel.type === 'VOICE' && call?.channelId !== channel.id) return fail('CALL_ENDED');
        // Free-form text only inside the customer-service window of the contact who wrote last; a notification to
        // someone else, or after the window, goes out as its approved template (ADR-0015).
        const inWindow =
          channel.type === 'VOICE' ||
          (!message.recipientIdentityId ||
          message.recipientIdentityId === conversation.channelIdentityId
            ? conversation.lastInboundAt !== null &&
              now.getTime() - conversation.lastInboundAt.getTime() <= REPLY_WINDOW_MS
            : false);
        if (!inWindow && !message.template) return fail('OUTSIDE_WINDOW');
        const to = call
          ? call.providerCallId
          : await this.recipient(conversation, message.recipientIdentityId);
        if (!to) return fail('NO_RECIPIENT');
        try {
          const adapter = this.runtime.adapterFor(channel);
          const ctx = this.runtime.context(channel);
          let result: SendResult;
          if (adapter.kind === 'VOICE') {
            const text = message.body ?? '';
            result = await adapter.say(ctx, {
              callId: to,
              text,
              audio: await this.voiceAudio(conversation, text),
            });
          } else if (adapter.kind !== 'MESSAGING') return fail('NOT_MESSAGING');
          else
            result =
              inWindow || !message.template
                ? await adapter.sendText(ctx, { to, body: message.body ?? '' })
                : await adapter.sendTemplate(ctx, {
                    to,
                    template: message.template.code,
                    locale: message.template.locale,
                    parameters: message.template.parameters,
                  });
          const updated = await this.repo.updateMessage(scope, message.id, {
            deliveryStatus: 'SENT',
            providerMessageId: result.providerMessageId,
            attempts: message.attempts + 1,
            nextAttemptAt: null,
          });
          await this.repo.insertDeliveryEvent({
            id: newId(),
            tenantId: message.tenantId,
            messageId: message.id,
            status: 'SENT',
            errorCode: null,
            occurredAt: now,
          });
          await this.announceSent(conversation, updated);
          return true;
        } catch (e) {
          const code =
            e instanceof ProviderError
              ? e.code
              : e instanceof AppError
                ? 'NOT_CONFIGURED'
                : 'ERROR';
          const attempts = message.attempts + 1;
          const retryable = e instanceof ProviderError ? e.retryable : false;
          if (!retryable || attempts >= MAX_SEND_ATTEMPTS) return fail(code);
          await this.repo.updateMessage(scope, message.id, {
            attempts,
            errorCode: code,
            nextAttemptAt: new Date(
              now.getTime() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!,
            ),
          });
          return false;
        }
      });
      if (done) sent++;
    }
    return sent;
  }

  /** The WhatsApp number of the message's recipient, else of the conversation's contact (its channel identity). */
  private async recipient(
    conversation: ConversationRow,
    recipientIdentityId: string | null = null,
  ): Promise<string | null> {
    const id = recipientIdentityId ?? conversation.channelIdentityId;
    if (!id) return null;
    const identity = await this.comms.identityById({ tenantId: conversation.tenantId }, id);
    return identity?.identifierNormalized ?? null;
  }

  // ---- guest web (Spec §18.1: one conversation across channels) ----

  async guestConversation(p: GuestPrincipal) {
    if (!p.stayId) return null;
    const conversation = await this.repo.latestConversationOfStay(
      { tenantId: p.tenantId },
      p.stayId,
    );
    if (!conversation) return { conversation: null, messages: [] };
    const messages = await this.repo.messagesOf({ tenantId: p.tenantId }, conversation.id, {
      guestVisibleOnly: true,
      limit: 200,
    });
    return {
      conversation: { id: conversation.id, status: conversation.status },
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        senderType: m.senderType,
        type: m.type,
        body: m.body,
        deliveryStatus: m.deliveryStatus,
        createdAt: m.createdAt,
      })),
    };
  }

  guestPost(p: GuestPrincipal, body: string) {
    return this.tx.run(async () => {
      if (!p.stayId) throw AppError.forbidden('guest.session.scope_missing', { scope: 'CHAT' });
      const scope = { tenantId: p.tenantId };
      const now = new Date();
      let conversation =
        (await this.repo.openConversationOfStay(scope, p.stayId)) ??
        (await this.open(
          { tenantId: p.tenantId, propertyId: p.propertyId },
          { guestId: p.guestId, stayId: p.stayId, identityId: null, replyChannelType: 'GUEST_WEB' },
        ));
      const guest = await this.repo.participant(scope, conversation.id, 'GUEST', p.guestId, now);
      const message = (await this.repo.insertMessage({
        id: newId(),
        tenantId: p.tenantId,
        conversationId: conversation.id,
        channelId: null,
        channelType: 'GUEST_WEB',
        direction: 'INBOUND',
        senderParticipantId: guest.id,
        senderType: 'GUEST',
        senderRef: p.guestId,
        type: 'TEXT',
        body,
        deliveryStatus: 'DELIVERED',
      }))!;
      conversation = await this.repo.updateConversation(scope, conversation.id, {
        replyChannelId: null,
        replyChannelType: 'GUEST_WEB',
        lastMessageAt: now,
        ...(conversation.status === 'HANDED_OFF' ? {} : { status: 'WAITING_STAFF' as const }),
      });
      await this.announceReceived(conversation, message);
      return { conversationId: conversation.id, messageId: message.id };
    });
  }

  // ---- guest notifications (Spec §25) ----

  /**
   * Tells a guest something about their stay (a service request moved on): a `SYSTEM` message in the stay's
   * conversation (opened for the guest web if there is none), shown at once on the guest web; when the guest has a
   * verified WhatsApp number and the property a usable WhatsApp channel it also goes out there — as text inside the
   * 24-hour window, otherwise as the approved template. Runs in the caller's transaction (rule 18: no context sends
   * through a provider directly).
   */
  notifyGuest(input: GuestNotificationInput): Promise<GuestNotificationResult> {
    return this.tx.run(async () => {
      const scope = { tenantId: input.tenantId };
      const at = { tenantId: input.tenantId, propertyId: input.propertyId };
      const now = new Date();
      const conversation =
        (await this.repo.openConversationOfStay(scope, input.stayId)) ??
        (await this.open(at, {
          guestId: input.guestId,
          stayId: input.stayId,
          identityId: null,
          replyChannelType: 'GUEST_WEB',
        }));
      const body = this.i18n.t(input.message.key, input.message.params ?? {}, input.locale);
      const identity = await this.identities.verifiedOfGuest(
        input.tenantId,
        input.guestId,
        'WHATSAPP',
      );
      const channel = identity ? await this.whatsappChannel(at, conversation) : undefined;
      const participant = await this.repo.participant(
        scope,
        conversation.id,
        'SYSTEM',
        input.source,
        now,
      );
      const message = (await this.repo.insertMessage({
        id: newId(),
        tenantId: input.tenantId,
        conversationId: conversation.id,
        channelId: channel?.id ?? null,
        channelType: channel ? 'WHATSAPP' : 'GUEST_WEB',
        direction: 'OUTBOUND',
        senderParticipantId: participant.id,
        senderType: 'SYSTEM',
        senderRef: input.source,
        type: 'SYSTEM',
        body,
        deliveryStatus: channel ? 'QUEUED' : 'SENT',
        nextAttemptAt: channel ? now : null,
        recipientIdentityId: channel ? identity!.id : null,
        template: input.template
          ? {
              code: input.template.code,
              locale: input.locale,
              parameters: [...input.template.parameters],
            }
          : null,
      }))!;
      await this.repo.updateConversation(scope, conversation.id, { lastMessageAt: now });
      // The guest web shows it at once; the WhatsApp copy is announced when it leaves.
      await this.announceSent(conversation, { ...message, channelType: 'GUEST_WEB' });
      return {
        conversationId: conversation.id,
        messageId: message.id,
        channelType: channel ? 'WHATSAPP' : 'GUEST_WEB',
      };
    });
  }

  // ---- AI (Spec §23–§24) ----

  conversationForAi(tenantId: string, conversationId: string): Promise<ConversationForAi | null> {
    return this.tx.read(async () => {
      const c = isUuid(conversationId)
        ? await this.repo.conversation({ tenantId }, conversationId)
        : undefined;
      return c
        ? {
            id: c.id,
            propertyId: c.propertyId,
            stayId: c.stayId,
            guestId: c.guestId,
            status: c.status,
            aiMode: c.aiMode,
          }
        : null;
    });
  }

  recentMessages(
    tenantId: string,
    conversationId: string,
    limit: number,
  ): Promise<readonly ConversationMessage[]> {
    return this.tx.read(async () =>
      (
        await this.repo.messagesOf({ tenantId }, conversationId, {
          guestVisibleOnly: true,
          limit: Math.min(Math.max(limit, 1), 50),
        })
      ).map((m) => ({
        id: m.id,
        direction: m.direction,
        senderType: m.senderType,
        body: m.body,
        channelType: m.channelType,
        // Voice reaches a stay only through room context (ADR-0025): the room, not a verified person.
        assurance:
          m.direction === 'INBOUND' && m.channelType === 'VOICE'
            ? ('ROOM_CONTEXT' as const)
            : ('VERIFIED' as const),
        createdAt: m.createdAt.toISOString(),
      })),
    );
  }

  saveDraft(input: {
    tenantId: string;
    conversationId: string;
    agentCode: string;
    executionId: string | null;
    body: string;
  }): Promise<{ draftId: string }> {
    return this.tx.run(async () => {
      const c = await this.repo.conversationForUpdate(
        { tenantId: input.tenantId },
        input.conversationId,
      );
      if (!c) throw AppError.notFound('comms.conversation.not_found');
      if (c.status === 'CLOSED') throw AppError.conflict('comms.conversation.closed');
      if (c.status === 'HANDED_OFF') throw AppError.conflict('comms.conversation.handed_off');
      const draft = await this.repo.putDraft({
        id: newId(),
        tenantId: c.tenantId,
        propertyId: c.propertyId,
        conversationId: c.id,
        agentCode: input.agentCode,
        executionId: input.executionId,
        body: input.body,
      });
      return { draftId: draft.id };
    });
  }

  replyAsAi(input: {
    tenantId: string;
    conversationId: string;
    agentCode: string;
    body: string;
  }): Promise<{ messageId: string; deliveryStatus: string }> {
    return this.tx.run(async () => {
      const conversation = await this.repo.conversation(
        { tenantId: input.tenantId },
        input.conversationId,
      );
      if (!conversation) throw AppError.notFound('comms.conversation.not_found');
      if (conversation.status === 'CLOSED') throw AppError.conflict('comms.conversation.closed');
      // Once a person has the conversation, the AI stays quiet.
      if (conversation.status === 'HANDED_OFF')
        throw AppError.conflict('comms.conversation.handed_off');
      const message = await this.queue(
        conversation,
        { type: 'AI', ref: input.agentCode },
        input.body,
      );
      return { messageId: message.id, deliveryStatus: message.deliveryStatus };
    });
  }

  handOff(input: { tenantId: string; conversationId: string; reason: string }): Promise<void> {
    return this.tx.run(async () => {
      const scope = { tenantId: input.tenantId };
      const c = await this.repo.conversation(scope, input.conversationId);
      if (!c) throw AppError.notFound('comms.conversation.not_found');
      if (c.status === 'CLOSED' || c.status === 'HANDED_OFF') return;
      const updated = await this.repo.updateConversation(scope, c.id, {
        status: 'HANDED_OFF',
        aiMode: 'OFF',
        handoffReason: input.reason,
      });
      await this.repo.discardPendingDrafts(scope, c.id);
      await this.events.publish(HandoffRequested, {
        tenantId: c.tenantId,
        propertyId: c.propertyId,
        source: COMMS,
        aggregate: { type: 'conversation', id: c.id },
        payload: { conversation_id: c.id, stay_id: c.stayId, by: 'AI', assigned_user_id: null },
      });
      await this.audit.record({
        action: 'comms.conversation.handoff',
        entityType: 'conversation',
        entityId: c.id,
        tenantId: c.tenantId,
        propertyId: c.propertyId,
        reason: input.reason,
        before: { status: c.status, ai_mode: c.aiMode },
        after: { status: updated.status, ai_mode: updated.aiMode },
      });
    });
  }

  /** The conversation's WhatsApp channel when it has one, else the property's first usable WhatsApp channel. */
  private async whatsappChannel(
    at: { tenantId: string; propertyId: string },
    conversation: ConversationRow,
  ): Promise<ChannelRow | undefined> {
    const usable = (c: ChannelRow | undefined) =>
      c &&
      c.status === 'ACTIVE' &&
      c.type === 'WHATSAPP' &&
      !['OFFLINE', 'AUTH_FAILED'].includes(c.health);
    if (conversation.replyChannelType === 'WHATSAPP' && conversation.replyChannelId) {
      const current = await this.comms.channelById(conversation.replyChannelId);
      if (usable(current)) return current;
    }
    return (await this.comms.activeChannels(at, 'WHATSAPP')).find(usable);
  }

  // ---- lifecycle ----

  static readonly consumes = [StayStatusChanged, GuestAnonymized] as const;

  /**
   * PMS-driven checkout (BUILD_PLAN §8.2): the stay's conversation closes and any AI auto mode stops; no staff action.
   * Anonymization clears message texts of the guest's conversations (who wrote when stays, CLAUDE.md rule 21).
   */
  async apply(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id) return;
    const scope = { tenantId: envelope.tenant_id };
    if (envelope.event_type === StayStatusChanged.type) {
      const e = StayStatusChanged.parse(envelope);
      if (!['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(e.payload.to)) return;
      await this.tx.run(async () => {
        for (const c of await this.repo.openConversationsOfStay(scope, e.payload.stay_id))
          await this.close(c, 'STAY_ENDED');
      });
    } else if (envelope.event_type === GuestAnonymized.type) {
      const e = GuestAnonymized.parse(envelope);
      await this.tx.run(async () => {
        await this.repo.clearGuestMessageBodies(scope, e.payload.guest_id);
        await this.repo.clearGuestDraftBodies(scope, e.payload.guest_id);
      });
    }
  }

  async close(conversation: ConversationRow, reason: string): Promise<ConversationRow> {
    const now = new Date();
    const scope = { tenantId: conversation.tenantId };
    const system = await this.repo.participant(scope, conversation.id, 'SYSTEM', null, now);
    await this.repo.insertMessage({
      id: newId(),
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      channelId: null,
      channelType: conversation.replyChannelType,
      direction: 'OUTBOUND',
      senderParticipantId: system.id,
      senderType: 'SYSTEM',
      type: 'SYSTEM',
      body: `closed:${reason}`,
      deliveryStatus: 'SENT',
      guestVisible: false,
    });
    await this.repo.discardPendingDrafts(scope, conversation.id);
    return this.repo.updateConversation(scope, conversation.id, {
      status: 'CLOSED',
      aiMode: 'OFF',
      closedAt: now,
    });
  }

  // ---- helpers ----

  private async open(
    at: { tenantId: string; propertyId: string },
    input: {
      guestId: string | null;
      stayId: string | null;
      identityId: string | null;
      replyChannelType: 'WHATSAPP' | 'GUEST_WEB' | 'VOICE';
    },
  ): Promise<ConversationRow> {
    const now = new Date();
    const conversation = await this.repo.insertConversation({
      id: newId(),
      tenantId: at.tenantId,
      propertyId: at.propertyId,
      guestId: input.guestId,
      stayId: input.stayId,
      channelIdentityId: input.identityId,
      replyChannelType: input.replyChannelType,
      // A verified guest's conversation starts in the property's AI mode; unverified contacts never meet the AI.
      aiMode: input.stayId
        ? await this.settings.value(COMMS_AI_MODE_DEFAULT, {
            tenantId: at.tenantId,
            propertyId: at.propertyId,
          })
        : 'OFF',
      lastMessageAt: now,
    });
    await this.events.publish(ConversationOpened, {
      tenantId: at.tenantId,
      propertyId: at.propertyId,
      source: COMMS,
      aggregate: { type: 'conversation', id: conversation.id },
      payload: {
        conversation_id: conversation.id,
        guest_id: input.guestId,
        stay_id: input.stayId,
        channel_type: input.replyChannelType,
      },
    });
    // Spec §61 WHATSAPP_CONVERSATIONS: metered with the conversation, in its transaction.
    if (input.replyChannelType === 'WHATSAPP')
      await this.usage?.record({
        tenantId: at.tenantId,
        propertyId: at.propertyId,
        metric: 'WHATSAPP_CONVERSATIONS',
        quantity: 1,
        occurredAt: now,
        source: COMMS,
        idempotencyKey: `conversation:${conversation.id}`,
      });
    return conversation;
  }

  private async announceReceived(conversation: ConversationRow, message: MessageRow) {
    await this.events.publish(MessageReceived, {
      tenantId: conversation.tenantId,
      propertyId: conversation.propertyId,
      source: COMMS,
      aggregate: { type: 'conversation', id: conversation.id },
      payload: {
        conversation_id: conversation.id,
        message_id: message.id,
        guest_id: conversation.guestId,
        stay_id: conversation.stayId,
        channel_type: message.channelType,
        message_type: message.type,
      },
    });
  }

  private async announceSent(conversation: ConversationRow, message: MessageRow) {
    await this.events.publish(MessageSent, {
      tenantId: conversation.tenantId,
      propertyId: conversation.propertyId,
      source: COMMS,
      aggregate: { type: 'conversation', id: conversation.id },
      payload: {
        conversation_id: conversation.id,
        message_id: message.id,
        channel_type: message.channelType,
        sender_type: message.senderType,
      },
    });
  }
}

/** Stored items come back from JSON: dates are strings again. */
function revive(item: InboundItem): InboundItem {
  return { ...item, at: new Date(item.at as unknown as string) } as InboundItem;
}
