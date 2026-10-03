import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { HandoffRequested } from '@hotella/contracts-events';
import { GUEST_API, type GrantActor, type GuestPublicApi } from '@hotella/domain-guest/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { maskPhone } from '../domain/phone';
import { ConversationRepositories } from '../infrastructure/conversation-repositories';
import type { ConversationRow } from '../infrastructure/schema';
import { CommsRepositories } from '../infrastructure/repositories';
import { ConversationService } from './conversation.service';

export const inboxQuerySchema = z.object({
  status: z
    .enum(['OPEN', 'WAITING_GUEST', 'WAITING_STAFF', 'HANDED_OFF', 'CLOSED'])
    .array()
    .or(
      z
        .enum(['OPEN', 'WAITING_GUEST', 'WAITING_STAFF', 'HANDED_OFF', 'CLOSED'])
        .transform((s) => [s]),
    )
    .optional(),
  mine: z.stringbool().optional(),
  unassigned: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const replySchema = z.object({ body: z.string().trim().min(1).max(4096) });
export const assignConversationSchema = z.object({
  userId: z.uuid().nullable(),
  version: z.number().int().min(1),
});
export const takeoverSchema = z.object({ reason: z.string().trim().max(200).optional() });
export const guestMessageSchema = z.object({ body: z.string().trim().min(1).max(4096) });

/**
 * The staff inbox (Spec §18, BUILD_PLAN §8.4): conversations with the guest, stay, room and open work beside them,
 * replies, assignment, takeover (hand-off: AI auto mode stops) and closing. Every action is permission-gated; takeovers
 * and closings are audited.
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly repo: ConversationRepositories,
    private readonly comms: CommsRepositories,
    private readonly engine: ConversationService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
  ) {}

  list(scope: PropertyScope, query: z.infer<typeof inboxQuerySchema>, actor: GrantActor) {
    return this.act(scope, 'inbox.read', 'read', async () => {
      const rows = await this.repo.listConversations(scope, {
        ...(query.status ? { statuses: query.status } : {}),
        assignedUserId: query.mine ? actor.id : null,
        unassigned: query.unassigned ?? false,
        limit: query.limit,
      });
      const out = [];
      for (const c of rows) {
        const [last] = (await this.repo.messagesOf(scope, c.id, { limit: 1 })).slice(-1);
        out.push({
          ...(await this.context(scope, c)),
          lastMessage: last
            ? {
                direction: last.direction,
                type: last.type,
                preview: (last.body ?? '').slice(0, 120),
                at: last.createdAt,
              }
            : null,
        });
      }
      return out;
    });
  }

  detail(scope: PropertyScope, id: string) {
    return this.act(scope, 'inbox.read', 'read', async () => {
      const c = await this.find(scope, id);
      const messages = await this.repo.messagesOf(scope, c.id, { limit: 200 });
      return {
        ...(await this.context(scope, c)),
        openWork: c.stayId
          ? (await this.ops.openWorkItemsOfStay(scope.tenantId, c.stayId)).map((w) => ({
              id: w.id,
              kind: w.kind,
              status: w.status,
              priority: w.priority,
              departmentCode: w.departmentCode,
            }))
          : [],
        // Filled by the AI layer in Phase 6.
        aiSummary: null,
        messages: messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          senderType: m.senderType,
          senderRef: m.senderRef,
          channelType: m.channelType,
          type: m.type,
          body: m.body,
          mediaRef: m.mediaRef,
          deliveryStatus: m.deliveryStatus,
          errorCode: m.errorCode,
          guestVisible: m.guestVisible,
          createdAt: m.createdAt,
        })),
      };
    });
  }

  reply(scope: PropertyScope, id: string, body: string, actor: GrantActor) {
    return this.act(scope, 'inbox.reply', 'write', async () => {
      const c = await this.find(scope, id, true);
      if (c.status === 'CLOSED') throw AppError.conflict('comms.conversation.closed');
      const message = await this.engine.queue(c, { type: 'STAFF', ref: actor.id }, body);
      await this.repo.updateConversation(scope, c.id, {
        status: c.status === 'HANDED_OFF' ? 'HANDED_OFF' : 'WAITING_GUEST',
        ...(c.assignedUserId ? {} : { assignedUserId: uuidOrNull(actor.id) }),
      });
      return { id: message.id, deliveryStatus: message.deliveryStatus };
    });
  }

  assign(scope: PropertyScope, id: string, input: z.infer<typeof assignConversationSchema>) {
    return this.act(scope, 'inbox.assign', 'write', async () => {
      const c = await this.find(scope, id, true);
      if (c.version !== input.version)
        throw AppError.conflict('comms.conversation.version_conflict');
      const updated = await this.repo.updateConversation(scope, c.id, {
        assignedUserId: input.userId,
      });
      await this.audit.record({
        action: 'comms.conversation.assign',
        entityType: 'conversation',
        entityId: c.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { assigned_user_id: c.assignedUserId },
        after: { assigned_user_id: input.userId },
      });
      return this.context(scope, updated);
    });
  }

  /** A person takes the conversation over: HANDED_OFF, AI auto mode off, assigned to them (Spec §18). */
  takeover(scope: PropertyScope, id: string, reason: string | undefined, actor: GrantActor) {
    return this.act(scope, 'inbox.takeover', 'write', async () => {
      const c = await this.find(scope, id, true);
      if (c.status === 'CLOSED') throw AppError.conflict('comms.conversation.closed');
      const now = new Date();
      const updated = await this.repo.updateConversation(scope, c.id, {
        status: 'HANDED_OFF',
        aiMode: 'OFF',
        assignedUserId: uuidOrNull(actor.id),
        handoffReason: reason ?? null,
      });
      await this.repo.participant(scope, c.id, 'STAFF', actor.id, now);
      await this.events.publish(HandoffRequested, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'comms',
        aggregate: { type: 'conversation', id: c.id },
        payload: {
          conversation_id: c.id,
          stay_id: c.stayId,
          by: 'STAFF',
          assigned_user_id: uuidOrNull(actor.id),
        },
      });
      await this.audit.record({
        action: 'comms.conversation.takeover',
        entityType: 'conversation',
        entityId: c.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        actor,
        ...(reason ? { reason } : {}),
        before: { status: c.status, ai_mode: c.aiMode },
        after: { status: updated.status, ai_mode: updated.aiMode },
      });
      return this.context(scope, updated);
    });
  }

  close(scope: PropertyScope, id: string) {
    return this.act(scope, 'inbox.reply', 'write', async () => {
      const c = await this.find(scope, id, true);
      if (c.status === 'CLOSED') throw AppError.conflict('comms.conversation.closed');
      const closed = await this.engine.close(c, 'STAFF');
      await this.audit.record({
        action: 'comms.conversation.close',
        entityType: 'conversation',
        entityId: c.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { status: c.status },
        after: { status: closed.status },
      });
      return this.context(scope, closed);
    });
  }

  /** Who and where: guest, stay and room come from the guest and organization contexts, never from the phone. */
  private async context(scope: PropertyScope, c: ConversationRow) {
    const stay = c.stayId ? await this.guests.getStay(scope.tenantId, c.stayId) : null;
    const member =
      c.stayId && c.guestId
        ? (await this.guests.stayParty(scope.tenantId, c.stayId)).find(
            (m) => m.guestId === c.guestId,
          )
        : undefined;
    const room = stay?.currentRoomId
      ? await this.org.getRoom(scope.tenantId, scope.propertyId, stay.currentRoomId)
      : null;
    const identity = c.channelIdentityId
      ? await this.comms.identityById(scope, c.channelIdentityId)
      : undefined;
    return {
      id: c.id,
      status: c.status,
      aiMode: c.aiMode,
      replyChannelType: c.replyChannelType,
      assignedUserId: c.assignedUserId,
      version: c.version,
      lastMessageAt: c.lastMessageAt,
      verified: Boolean(c.stayId),
      contact: identity ? maskPhone(identity.identifierNormalized) : null,
      guest: member
        ? {
            id: member.guestId,
            givenName: member.givenName,
            familyName: member.familyName,
            role: member.role,
          }
        : null,
      stay: stay
        ? {
            id: stay.id,
            status: stay.status,
            expectedDeparture: stay.expectedDeparture,
            room: room ? { id: room.id, number: room.roomNumber } : null,
          }
        : null,
    };
  }

  private async find(
    scope: PropertyScope,
    id: string,
    forUpdate = false,
  ): Promise<ConversationRow> {
    const c = isUuid(id)
      ? forUpdate
        ? await this.repo.conversationForUpdate(scope, id)
        : await this.repo.conversation(scope, id)
      : undefined;
    if (!c || c.propertyId !== scope.propertyId)
      throw AppError.notFound('comms.conversation.not_found');
    return c;
  }

  private act<T>(
    scope: PropertyScope,
    permission: string,
    mode: 'read' | 'write',
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.gate.execute(
      { action: permission, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (mode === 'read' ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}

function uuidOrNull(id: string | null): string | null {
  return id && isUuid(id) ? id : null;
}
