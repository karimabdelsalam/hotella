import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  newId,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  conversationParticipants,
  conversations,
  inboundEvents,
  messageDeliveryEvents,
  messages,
  replyDrafts,
  type ConversationRow,
  type ReplyDraftRow,
  type InboundEventRow,
  type MessageRow,
  type ParticipantRow,
} from './schema';

/** Inbound events, conversations, participants and messages. */
@Injectable()
export class ConversationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- inbound events ----
  /** Stores a webhook item once; returns undefined for a repeat of the same provider id. */
  async insertInbound(
    values: typeof inboundEvents.$inferInsert,
  ): Promise<InboundEventRow | undefined> {
    const [row] = await this.x
      .insert(inboundEvents)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  inboundForUpdate(scope: TenantScope, id: string): Promise<InboundEventRow | undefined> {
    return this.x
      .select()
      .from(inboundEvents)
      .where(
        tenantWhere(
          inboundEvents,
          scope,
          eq(inboundEvents.id, id),
          eq(inboundEvents.status, 'RECEIVED'),
        ),
      )
      .for('update', { skipLocked: true })
      .then((r) => r[0]);
  }
  pendingInbound(before: Date, limit: number): Promise<Array<{ id: string; tenantId: string }>> {
    return this.x
      .select({ id: inboundEvents.id, tenantId: inboundEvents.tenantId })
      .from(inboundEvents)
      .where(and(eq(inboundEvents.status, 'RECEIVED'), lte(inboundEvents.receivedAt, before)))
      .orderBy(asc(inboundEvents.receivedAt), asc(inboundEvents.id))
      .limit(limit);
  }
  async finishInbound(
    scope: TenantScope,
    id: string,
    values: Partial<typeof inboundEvents.$inferInsert>,
  ): Promise<void> {
    await this.x
      .update(inboundEvents)
      .set({ ...values, updatedAt: new Date() })
      .where(tenantWhere(inboundEvents, scope, eq(inboundEvents.id, id)));
  }

  // ---- conversations ----
  async insertConversation(values: typeof conversations.$inferInsert): Promise<ConversationRow> {
    const [row] = await this.x.insert(conversations).values(values).returning();
    return row!;
  }
  conversation(scope: TenantScope, id: string): Promise<ConversationRow | undefined> {
    return this.x
      .select()
      .from(conversations)
      .where(tenantWhere(conversations, scope, eq(conversations.id, id)))
      .then((r) => r[0]);
  }
  conversationForUpdate(scope: TenantScope, id: string): Promise<ConversationRow | undefined> {
    return this.x
      .select()
      .from(conversations)
      .where(tenantWhere(conversations, scope, eq(conversations.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  openConversationOfStay(scope: TenantScope, stayId: string): Promise<ConversationRow | undefined> {
    return this.x
      .select()
      .from(conversations)
      .where(
        tenantWhere(
          conversations,
          scope,
          eq(conversations.stayId, stayId),
          ne(conversations.status, 'CLOSED'),
        ),
      )
      .for('update')
      .then((r) => r[0]);
  }
  openConversationOfIdentity(
    scope: PropertyScope,
    identityId: string,
  ): Promise<ConversationRow | undefined> {
    return this.x
      .select()
      .from(conversations)
      .where(
        propertyWhere(
          conversations,
          scope,
          eq(conversations.channelIdentityId, identityId),
          isNull(conversations.stayId),
          ne(conversations.status, 'CLOSED'),
        ),
      )
      .for('update')
      .then((r) => r[0]);
  }
  openConversationsOfStay(scope: TenantScope, stayId: string): Promise<ConversationRow[]> {
    return this.x
      .select()
      .from(conversations)
      .where(
        tenantWhere(
          conversations,
          scope,
          eq(conversations.stayId, stayId),
          ne(conversations.status, 'CLOSED'),
        ),
      )
      .for('update');
  }
  /** The guest's conversation for the stay in their session (open first, else the latest). */
  latestConversationOfStay(
    scope: TenantScope,
    stayId: string,
  ): Promise<ConversationRow | undefined> {
    return this.x
      .select()
      .from(conversations)
      .where(tenantWhere(conversations, scope, eq(conversations.stayId, stayId)))
      .orderBy(sql`(${conversations.status} = 'CLOSED')`, desc(conversations.id))
      .limit(1)
      .then((r) => r[0]);
  }
  listConversations(
    scope: PropertyScope,
    filter: {
      statuses?: readonly ConversationRow['status'][];
      assignedUserId?: string | null;
      unassigned?: boolean;
      limit: number;
    },
  ): Promise<ConversationRow[]> {
    return this.x
      .select()
      .from(conversations)
      .where(
        propertyWhere(
          conversations,
          scope,
          filter.statuses?.length ? inArray(conversations.status, [...filter.statuses]) : undefined,
          filter.assignedUserId
            ? eq(conversations.assignedUserId, filter.assignedUserId)
            : undefined,
          filter.unassigned ? isNull(conversations.assignedUserId) : undefined,
        ),
      )
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
      .limit(filter.limit);
  }
  async updateConversation(
    scope: TenantScope,
    id: string,
    values: Partial<typeof conversations.$inferInsert>,
  ): Promise<ConversationRow> {
    const [row] = await this.x
      .update(conversations)
      .set({ ...values, version: sql`${conversations.version} + 1`, updatedAt: new Date() })
      .where(tenantWhere(conversations, scope, eq(conversations.id, id)))
      .returning();
    return row!;
  }

  // ---- participants ----
  async participant(
    scope: TenantScope,
    conversationId: string,
    type: ParticipantRow['participantType'],
    ref: string | null,
    at: Date,
  ): Promise<ParticipantRow> {
    const [existing] = await this.x
      .select()
      .from(conversationParticipants)
      .where(
        tenantWhere(
          conversationParticipants,
          scope,
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.participantType, type),
          ref === null
            ? isNull(conversationParticipants.participantRef)
            : eq(conversationParticipants.participantRef, ref),
          isNull(conversationParticipants.leftAt),
        ),
      );
    if (existing) return existing;
    const [row] = await this.x
      .insert(conversationParticipants)
      .values({
        id: newId(),
        tenantId: scope.tenantId,
        conversationId,
        participantType: type,
        participantRef: ref,
        joinedAt: at,
      })
      .returning();
    return row!;
  }
  participants(scope: TenantScope, conversationId: string): Promise<ParticipantRow[]> {
    return this.x
      .select()
      .from(conversationParticipants)
      .where(
        tenantWhere(
          conversationParticipants,
          scope,
          eq(conversationParticipants.conversationId, conversationId),
        ),
      )
      .orderBy(asc(conversationParticipants.id));
  }

  // ---- messages ----
  async insertMessage(values: typeof messages.$inferInsert): Promise<MessageRow | undefined> {
    const [row] = await this.x.insert(messages).values(values).onConflictDoNothing().returning();
    return row;
  }
  messagesOf(
    scope: TenantScope,
    conversationId: string,
    opts: { guestVisibleOnly?: boolean; limit: number },
  ): Promise<MessageRow[]> {
    return this.x
      .select()
      .from(messages)
      .where(
        tenantWhere(
          messages,
          scope,
          eq(messages.conversationId, conversationId),
          opts.guestVisibleOnly ? eq(messages.guestVisible, true) : undefined,
        ),
      )
      .orderBy(desc(messages.id))
      .limit(opts.limit)
      .then((rows) => rows.reverse());
  }
  messageByProviderId(
    scope: TenantScope,
    channelId: string,
    providerMessageId: string,
  ): Promise<MessageRow | undefined> {
    return this.x
      .select()
      .from(messages)
      .where(
        tenantWhere(
          messages,
          scope,
          eq(messages.channelId, channelId),
          eq(messages.providerMessageId, providerMessageId),
        ),
      )
      .then((r) => r[0]);
  }
  dueOutbound(now: Date, limit: number): Promise<Array<{ id: string; tenantId: string }>> {
    return this.x
      .select({ id: messages.id, tenantId: messages.tenantId })
      .from(messages)
      .where(and(eq(messages.deliveryStatus, 'QUEUED'), lte(messages.nextAttemptAt, now)))
      .orderBy(asc(messages.nextAttemptAt), asc(messages.id))
      .limit(limit);
  }
  claimOutbound(scope: TenantScope, id: string): Promise<MessageRow | undefined> {
    return this.x
      .select()
      .from(messages)
      .where(
        tenantWhere(messages, scope, eq(messages.id, id), eq(messages.deliveryStatus, 'QUEUED')),
      )
      .for('update', { skipLocked: true })
      .then((r) => r[0]);
  }
  async updateMessage(
    scope: TenantScope,
    id: string,
    values: Partial<typeof messages.$inferInsert>,
  ): Promise<MessageRow> {
    const [row] = await this.x
      .update(messages)
      .set({ ...values, updatedAt: new Date() })
      .where(tenantWhere(messages, scope, eq(messages.id, id)))
      .returning();
    return row!;
  }
  /** Moves an outbound message's delivery status forward only (receipts arrive out of order). */
  async advanceDelivery(
    scope: TenantScope,
    id: string,
    status: MessageRow['deliveryStatus'],
    errorCode: string | null,
  ): Promise<MessageRow | undefined> {
    const rank = sql`case ${messages.deliveryStatus} when 'QUEUED' then 0 when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3 else 4 end`;
    const next = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 }[status];
    const [row] = await this.x
      .update(messages)
      .set({ deliveryStatus: status, errorCode, updatedAt: new Date() })
      .where(tenantWhere(messages, scope, eq(messages.id, id), sql`${rank} < ${next}`))
      .returning();
    return row;
  }
  async insertDeliveryEvent(values: typeof messageDeliveryEvents.$inferInsert): Promise<void> {
    await this.x.insert(messageDeliveryEvents).values(values);
  }
  /** Anonymization: message texts of the guest's conversations are cleared; the history of who/when stays. */
  async clearGuestMessageBodies(scope: TenantScope, guestId: string): Promise<number> {
    const rows = await this.x
      .update(messages)
      .set({ body: null, mediaRef: null, template: null, updatedAt: new Date() })
      .where(
        tenantWhere(
          messages,
          scope,
          inArray(
            messages.conversationId,
            this.x
              .select({ id: conversations.id })
              .from(conversations)
              .where(tenantWhere(conversations, scope, eq(conversations.guestId, guestId))),
          ),
        ),
      )
      .returning({ id: messages.id });
    return rows.length;
  }

  // ---- AI drafts ----
  /** Replaces the conversation's pending draft (the newest suggestion wins). */
  async putDraft(values: Omit<typeof replyDrafts.$inferInsert, 'status'>): Promise<ReplyDraftRow> {
    await this.x
      .update(replyDrafts)
      .set({
        status: 'SUPERSEDED',
        updatedAt: new Date(),
        version: sql`${replyDrafts.version} + 1`,
      })
      .where(
        tenantWhere(
          replyDrafts,
          { tenantId: values.tenantId },
          eq(replyDrafts.conversationId, values.conversationId),
          eq(replyDrafts.status, 'PENDING'),
        ),
      );
    const [row] = await this.x.insert(replyDrafts).values(values).returning();
    return row!;
  }
  async pendingDraft(
    scope: TenantScope,
    conversationId: string,
  ): Promise<ReplyDraftRow | undefined> {
    const [row] = await this.x
      .select()
      .from(replyDrafts)
      .where(
        tenantWhere(
          replyDrafts,
          scope,
          eq(replyDrafts.conversationId, conversationId),
          eq(replyDrafts.status, 'PENDING'),
        ),
      );
    return row;
  }
  async draftForUpdate(scope: TenantScope, id: string): Promise<ReplyDraftRow | undefined> {
    const [row] = await this.x
      .select()
      .from(replyDrafts)
      .where(tenantWhere(replyDrafts, scope, eq(replyDrafts.id, id)))
      .for('update');
    return row;
  }
  async updateDraft(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<ReplyDraftRow, 'status' | 'usedAt' | 'usedById' | 'editDistance'>>,
  ): Promise<void> {
    await this.x
      .update(replyDrafts)
      .set({ ...patch, updatedAt: new Date(), version: sql`${replyDrafts.version} + 1` })
      .where(tenantWhere(replyDrafts, scope, eq(replyDrafts.id, id)));
  }
  /** Drafts of open conversations no longer apply once staff take over, the AI hands off or it closes. */
  async discardPendingDrafts(scope: TenantScope, conversationId: string): Promise<void> {
    await this.x
      .update(replyDrafts)
      .set({ status: 'DISCARDED', updatedAt: new Date(), version: sql`${replyDrafts.version} + 1` })
      .where(
        tenantWhere(
          replyDrafts,
          scope,
          eq(replyDrafts.conversationId, conversationId),
          eq(replyDrafts.status, 'PENDING'),
        ),
      );
  }
  async clearGuestDraftBodies(scope: TenantScope, guestId: string): Promise<void> {
    await this.x
      .update(replyDrafts)
      .set({ body: null, updatedAt: new Date() })
      .where(
        tenantWhere(
          replyDrafts,
          scope,
          inArray(
            replyDrafts.conversationId,
            this.x
              .select({ id: conversations.id })
              .from(conversations)
              .where(tenantWhere(conversations, scope, eq(conversations.guestId, guestId))),
          ),
        ),
      );
  }
}
