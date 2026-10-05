import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  CallEnded,
  CallStarted,
  type EventEnvelope,
  HandoffRequested,
} from '@hotella/contracts-events';
import { GUEST_API, type GuestPublicApi, type StaySummary } from '@hotella/domain-guest/public';
import { USAGE_API, type UsagePublicApi } from '@hotella/domain-licensing/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { ActionGate } from '@hotella/platform-auth';
import { newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { SettingsReader } from '@hotella/platform-settings';
import { COMMS_VOICE_ROOM_PHONE_TRUSTED } from '../domain/settings';
import { CallRepositories } from '../infrastructure/call-repositories';
import { ConversationRepositories } from '../infrastructure/conversation-repositories';
import { CommsRepositories } from '../infrastructure/repositories';
import type { CallRow, ChannelRow } from '../infrastructure/schema';
import { ChannelRuntime } from './channel.service';
import { ConversationService } from './conversation.service';
import { ChannelIdentityService } from './identity.service';
import type { VoiceEvent, VoiceProvider } from './providers';
import { SpeechRegistry } from './speech';

const COMMS = 'comms';

/** Why the platform hands a call to the operator (stored on the call; deterministic, CLAUDE.md rule 11). */
export type TransferReason =
  | 'UNTRUSTED_CALLER'
  | 'AI_OFF'
  | 'HANDED_OFF'
  | 'BUSY'
  | 'HANDOFF'
  | 'SPEECH_UNAVAILABLE'
  | 'SPEECH_FAILED';

export const callsQuerySchema = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The voice channel (BUILD_PLAN 13.4). The gateway reports calls; a call from a room phone of an in-house stay — only
 * where the property trusts room phones (Q27) — joins that stay's conversation and is answered by whoever answers the
 * conversation (the concierge in AUTO mode). Every other call, and every call the platform cannot serve, goes to the
 * operator extension at once. Utterance audio is transcribed here and dropped; only the words are kept.
 */
@Injectable()
export class VoiceService {
  constructor(
    private readonly calls: CallRepositories,
    private readonly conversations: ConversationRepositories,
    private readonly comms: CommsRepositories,
    private readonly engine: ConversationService,
    private readonly identities: ChannelIdentityService,
    private readonly runtime: ChannelRuntime,
    private readonly speech: SpeechRegistry,
    private readonly events: EventPublisher,
    private readonly tx: TransactionRunner,
    private readonly settings: SettingsReader,
    private readonly gate: ActionGate,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(USAGE_API) private readonly usage?: UsagePublicApi,
  ) {}

  /** Applies verified gateway events in order; each is idempotent (a repeated delivery changes nothing). */
  async receive(channel: ChannelRow, events: readonly VoiceEvent[]): Promise<{ applied: number }> {
    let applied = 0;
    for (const e of events) {
      const done =
        e.kind === 'CALL_STARTED'
          ? await this.started(channel, e)
          : e.kind === 'UTTERANCE'
            ? await this.utterance(channel, e)
            : await this.ended(channel, e);
      if (done) applied++;
    }
    return { applied };
  }

  // ---- call lifecycle ----

  private async started(
    channel: ChannelRow,
    e: Extract<VoiceEvent, { kind: 'CALL_STARTED' }>,
  ): Promise<boolean> {
    const config = this.config(channel);
    const outcome = await this.tx.run(async () => {
      const scope = { tenantId: channel.tenantId };
      const identity = await this.identities.observe(channel.tenantId, 'VOICE', e.from, e.at);
      const stay = await this.roomPhoneStay(channel, e.from, config.roomExtensionPrefix);
      let reason: TransferReason | null = stay ? null : 'UNTRUSTED_CALLER';
      const conversation = stay
        ? await this.engine.conversationForCall(channel, stay, identity.id)
        : null;
      if (conversation && !reason) {
        if (conversation.status === 'HANDED_OFF') reason = 'HANDED_OFF';
        else if (conversation.aiMode !== 'AUTO') reason = 'AI_OFF';
        else if (await this.calls.liveOfConversation(scope, conversation.id)) reason = 'BUSY';
      }
      const call = await this.calls.insert({
        id: newId(),
        tenantId: channel.tenantId,
        propertyId: channel.propertyId,
        channelId: channel.id,
        providerCallId: e.callId,
        fromIdentityId: identity.id,
        conversationId: conversation?.id ?? null,
        stayId: stay?.id ?? null,
        status: reason ? 'TRANSFERRED' : 'ANSWERED',
        transferReason: reason,
        transferExtension: reason ? config.operatorExtension : null,
        startedAt: e.at,
        answeredAt: reason ? null : e.at,
        transferredAt: reason ? e.at : null,
        resumeReply:
          conversation && !reason
            ? // A conversation the call itself opened answers on the guest web afterwards.
              conversation.replyChannelType === 'VOICE'
              ? { channelId: null, channelType: 'GUEST_WEB' as const, identityId: null }
              : {
                  channelId: conversation.replyChannelId,
                  channelType: conversation.replyChannelType,
                  identityId: conversation.channelIdentityId,
                }
            : null,
      });
      if (!call) return null; // the same call reported twice
      // While the call is live, the conversation answers by voice.
      if (conversation && !reason)
        await this.conversations.updateConversation(scope, conversation.id, {
          replyChannelId: channel.id,
          replyChannelType: 'VOICE',
          channelIdentityId: identity.id,
        });
      await this.events.publish(CallStarted, {
        tenantId: channel.tenantId,
        propertyId: channel.propertyId,
        source: COMMS,
        aggregate: { type: 'call', id: call.id },
        payload: {
          call_id: call.id,
          conversation_id: call.conversationId,
          stay_id: call.stayId,
          status: reason ? 'TRANSFERRED' : 'ANSWERED',
          transfer_reason: reason,
        },
      });
      return call;
    });
    if (!outcome) return false;
    if (outcome.status === 'TRANSFERRED')
      await this.transferNow(channel, outcome.providerCallId, config.operatorExtension);
    return true;
  }

  private async utterance(
    channel: ChannelRow,
    e: Extract<VoiceEvent, { kind: 'UTTERANCE' }>,
  ): Promise<boolean> {
    const scope = { tenantId: channel.tenantId };
    const current = await this.tx.run(() => this.calls.byProviderId(scope, channel.id, e.callId));
    if (!current || current.status !== 'ANSWERED' || !current.conversationId) return false;
    let text = e.text;
    if (!text && e.audio) {
      // Speech to text outside any transaction; the audio lives only in this request (Q23).
      const port = this.speech.current();
      if (!port) return this.transfer(channel, e.callId, 'SPEECH_UNAVAILABLE');
      try {
        const heard = await port.transcribe({
          tenantId: channel.tenantId,
          propertyId: channel.propertyId,
          audio: e.audio.data,
          mimeType: e.audio.mimeType,
          language: e.language,
        });
        text = heard.text.trim() || null;
      } catch (err) {
        this.logger.warn({ call_id: current.id, err }, 'voice utterance not transcribed');
        return this.transfer(channel, e.callId, 'SPEECH_FAILED');
      }
    }
    if (!text) return false; // silence
    const words = text;
    return this.tx.run(async () => {
      const call = await this.calls.byProviderId(scope, channel.id, e.callId);
      if (!call || call.status !== 'ANSWERED' || !call.conversationId) return false;
      const conversation = await this.conversations.conversation(scope, call.conversationId);
      if (!conversation) return false;
      return this.engine.receiveUtterance(conversation, channel, {
        providerMessageId: `${call.providerCallId}:${e.utteranceId}`.slice(0, 160),
        text: words.slice(0, 4000),
        at: e.at,
      });
    });
  }

  private ended(
    channel: ChannelRow,
    e: Extract<VoiceEvent, { kind: 'CALL_ENDED' }>,
  ): Promise<boolean> {
    return this.tx.run(async () => {
      const scope = { tenantId: channel.tenantId };
      const call = await this.calls.byProviderId(scope, channel.id, e.callId);
      if (!call || call.status === 'ENDED') return false;
      // The platform's share of the call: from answering until a transfer or the end (metered, Spec §61).
      const answeredSeconds = call.answeredAt
        ? Math.max(
            0,
            Math.round(((call.transferredAt ?? e.at).getTime() - call.answeredAt.getTime()) / 1000),
          )
        : 0;
      if (call.status === 'ANSWERED') await this.resumeReply(call);
      const ended = await this.calls.update(scope, call.id, {
        status: 'ENDED',
        endedAt: e.at,
        durationSeconds: e.durationSeconds,
      });
      await this.events.publish(CallEnded, {
        tenantId: call.tenantId,
        propertyId: call.propertyId,
        source: COMMS,
        aggregate: { type: 'call', id: call.id },
        payload: {
          call_id: call.id,
          conversation_id: call.conversationId,
          stay_id: call.stayId,
          transferred: ended.transferredAt !== null,
          duration_s: e.durationSeconds,
          answered_seconds: answeredSeconds,
        },
      });
      if (answeredSeconds > 0)
        await this.usage?.record({
          tenantId: call.tenantId,
          propertyId: call.propertyId,
          metric: 'VOICE_MINUTES',
          quantity: Math.ceil(answeredSeconds / 60),
          occurredAt: e.at,
          source: COMMS,
          idempotencyKey: `call:${call.id}`,
        });
      return true;
    });
  }

  // ---- hand-off (worker consumer) ----

  static readonly consumes = [HandoffRequested] as const;

  /** A conversation handed to staff while its call is live: the call goes to the operator. */
  async apply(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id || envelope.event_type !== HandoffRequested.type) return;
    const e = HandoffRequested.parse(envelope);
    const call = await this.tx.read(() =>
      this.calls.liveOfConversationRead(
        { tenantId: envelope.tenant_id! },
        e.payload.conversation_id,
      ),
    );
    if (!call) return;
    const channel = await this.comms.channelById(call.channelId);
    if (!channel) return;
    await this.transfer(channel, call.providerCallId, 'HANDOFF');
  }

  // ---- staff read ----

  list(scope: PropertyScope, query: z.infer<typeof callsQuerySchema>) {
    return this.gate.execute(
      { action: 'inbox.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () =>
          (
            await this.calls.list(scope, {
              ...(query.before ? { before: new Date(query.before) } : {}),
              limit: query.limit,
            })
          ).map(view),
        ),
    );
  }

  // ---- helpers ----

  /** Moves a live call to the operator and records why; the gateway is asked after the commit. */
  private async transfer(
    channel: ChannelRow,
    providerCallId: string,
    reason: TransferReason,
  ): Promise<boolean> {
    const extension = this.config(channel).operatorExtension;
    const moved = await this.tx.run(async () => {
      const scope = { tenantId: channel.tenantId };
      const call = await this.calls.byProviderId(scope, channel.id, providerCallId);
      if (!call || call.status !== 'ANSWERED') return false;
      await this.resumeReply(call);
      await this.calls.update(scope, call.id, {
        status: 'TRANSFERRED',
        transferReason: reason,
        transferExtension: extension,
        transferredAt: new Date(),
      });
      return true;
    });
    if (moved) await this.transferNow(channel, providerCallId, extension);
    return moved;
  }

  /** Asks the gateway to transfer; a gateway that hears nothing routes to its own operator fallback. */
  private async transferNow(channel: ChannelRow, callId: string, extension: string) {
    try {
      await this.adapter(channel).transfer(this.runtime.context(channel), { callId, extension });
    } catch (err) {
      this.logger.warn({ channel_id: channel.id, err }, 'voice transfer not confirmed');
    }
  }

  /** The conversation replies again where it did before the call (unless something else changed it since). */
  private async resumeReply(call: CallRow) {
    if (!call.conversationId || !call.resumeReply) return;
    const scope = { tenantId: call.tenantId };
    const conversation = await this.conversations.conversation(scope, call.conversationId);
    if (
      conversation?.replyChannelType !== 'VOICE' ||
      conversation.replyChannelId !== call.channelId
    )
      return;
    await this.conversations.updateConversation(scope, conversation.id, {
      replyChannelId: call.resumeReply.channelId,
      replyChannelType: call.resumeReply.channelType,
      channelIdentityId: call.resumeReply.identityId,
    });
  }

  /**
   * The in-house stay a room phone stands for: only when the property trusts room phones, the caller is
   * `<prefix><room number>` of a known room, and exactly one in-house stay is in that room (never a guess, rule 16).
   */
  private async roomPhoneStay(
    channel: ChannelRow,
    from: string,
    prefix: string,
  ): Promise<StaySummary | null> {
    const at = { tenantId: channel.tenantId, propertyId: channel.propertyId };
    if (!(await this.settings.value(COMMS_VOICE_ROOM_PHONE_TRUSTED, at))) return null;
    if (!/^\d{1,16}$/.test(from) || !from.startsWith(prefix) || from.length === prefix.length)
      return null;
    const room = await this.org.getRoomByNumber(
      at.tenantId,
      at.propertyId,
      from.slice(prefix.length),
    );
    if (!room) return null;
    const stays = await this.guests.inHouseStaysInRoom(at.tenantId, at.propertyId, room.id);
    return stays.length === 1 ? stays[0]! : null;
  }

  private adapter(channel: ChannelRow): VoiceProvider {
    const adapter = this.runtime.adapterFor(channel);
    if (adapter.kind !== 'VOICE') throw new Error('not a voice channel');
    return adapter;
  }

  private config(channel: ChannelRow): { operatorExtension: string; roomExtensionPrefix: string } {
    return this.runtime.context(channel).config as {
      operatorExtension: string;
      roomExtensionPrefix: string;
    };
  }
}

function view(c: CallRow) {
  return {
    id: c.id,
    channelId: c.channelId,
    conversationId: c.conversationId,
    stayId: c.stayId,
    status: c.status,
    transferReason: c.transferReason,
    transferExtension: c.transferExtension,
    startedAt: c.startedAt,
    answeredAt: c.answeredAt,
    transferredAt: c.transferredAt,
    endedAt: c.endedAt,
    durationSeconds: c.durationSeconds,
  };
}
