import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  ConversationOpened,
  DeliveryUpdated,
  type EventEnvelope,
  HandoffRequested,
  MessageReceived,
  MessageSent,
} from '@hotella/contracts-events';
import { InjectValkey } from '@hotella/platform-queue';
import { ConversationRepositories } from '../infrastructure/conversation-repositories';

/** Valkey pub/sub channel per tenant; every API instance subscribes and fans out to its own sockets. */
export const REALTIME_CHANNEL_PREFIX = 'hotella:rt:';

/** What travels on the bus and to clients: ids and the event name only — clients fetch content over REST. */
export interface RealtimeNotice {
  readonly event: string;
  readonly tenantId: string;
  readonly propertyId: string;
  readonly conversationId: string;
  readonly stayId: string | null;
  readonly messageId: string | null;
}

/**
 * Worker side of realtime (Spec §18, BUILD_PLAN §8.2): conversation events become notices on the tenant's pub/sub
 * channel. Pub/sub (not a queue) because every gateway instance must see every notice.
 */
@Injectable()
export class RealtimeRelay {
  constructor(
    private readonly repo: ConversationRepositories,
    @InjectValkey() private readonly valkey: Redis,
  ) {}

  static readonly consumes = [
    ConversationOpened,
    MessageReceived,
    MessageSent,
    DeliveryUpdated,
    HandoffRequested,
  ] as const;

  async apply(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id || !envelope.property_id) return;
    const p = envelope.payload as { conversation_id?: string; message_id?: string };
    if (!p.conversation_id) return;
    const conversation = await this.repo.conversation(
      { tenantId: envelope.tenant_id },
      p.conversation_id,
    );
    if (!conversation) return;
    const notice: RealtimeNotice = {
      event: envelope.event_type,
      tenantId: envelope.tenant_id,
      propertyId: conversation.propertyId,
      conversationId: conversation.id,
      stayId: conversation.stayId,
      messageId: p.message_id ?? null,
    };
    await this.valkey.publish(
      `${REALTIME_CHANNEL_PREFIX}${envelope.tenant_id}`,
      JSON.stringify(notice),
    );
  }
}
