import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CATALOG_API, type CatalogPublicApi } from '@hotella/domain-catalog/public';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
} from '@hotella/domain-communications/public';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AppError } from '@hotella/platform-i18n';
import type { AiToolDefinition, ToolContext, ToolRegistry } from './registry';

const OPEN = new Set(['OPEN', 'IN_PROGRESS']);

/** The guest of the execution (tools declaring `needs.guest` only run with one). */
const guestOf = (ctx: ToolContext) => ctx.guest!;

/**
 * Tools v1 (BUILD_PLAN 6.2). Their handlers live in the AI context and act only through the public APIs of the owning
 * contexts, which keeps the dependency direction one-way (contexts never import the AI package). The guest, stay and
 * conversation come from the execution context, so a model can never act for another guest.
 */
@Injectable()
export class ToolsV1 {
  constructor(
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogPublicApi,
    @Inject(COMMUNICATIONS_API) private readonly comms: CommunicationsPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  registerInto(registry: ToolRegistry): void {
    registry.register(this.currentStay());
    registry.register(this.listServices());
    registry.register(this.openRequests());
    registry.register(this.createRequest());
    registry.register(this.cancelRequest());
    registry.register(this.sendMessage());
  }

  private currentStay(): AiToolDefinition<Record<string, never>> {
    return {
      code: 'guest.get_current_stay',
      description:
        "The guest's current stay: status, expected arrival and departure, and room number.",
      risk: 'READ',
      requiredPermission: 'stay.read',
      input: z.object({}).strict(),
      needs: { guest: true },
      handle: async (_args, ctx) => {
        const stay = await this.guests.getStay(ctx.tenantId, guestOf(ctx).stayId);
        if (!stay) throw AppError.notFound('guest.stay.not_found');
        const room = stay.currentRoomId
          ? await this.org.getRoom(ctx.tenantId, ctx.propertyId, stay.currentRoomId)
          : null;
        return {
          status: stay.status,
          expected_arrival: stay.expectedArrival,
          expected_departure: stay.expectedDeparture,
          room_number: room?.roomNumber ?? null,
        };
      },
    };
  }

  private listServices(): AiToolDefinition<Record<string, never>> {
    return {
      code: 'catalog.list_services',
      description:
        'Services this guest may request right now, in their language, with the fields each request needs.',
      risk: 'READ',
      requiredPermission: 'catalog.read',
      input: z.object({}).strict(),
      needs: { guest: true },
      handle: async (_args, ctx) => {
        const g = guestOf(ctx);
        const services = await this.catalog.servicesForGuest({
          tenantId: ctx.tenantId,
          propertyId: ctx.propertyId,
          stayId: g.stayId,
          guestId: g.guestId,
          locale: ctx.locale,
        });
        return services.map((s) => ({
          code: s.code,
          name: s.name,
          description: s.shortDescription,
          open_now: s.openNow,
          fields: s.fields,
        }));
      },
    };
  }

  private openRequests(): AiToolDefinition<Record<string, never>> {
    return {
      code: 'operations.find_open_requests',
      description: "The guest's service requests that are still open or in progress.",
      risk: 'READ',
      requiredPermission: 'request.read',
      input: z.object({}).strict(),
      needs: { guest: true },
      handle: async (_args, ctx) => {
        const requests = await this.catalog.serviceRequestsOfStay(
          ctx.tenantId,
          guestOf(ctx).stayId,
        );
        return requests
          .filter((r) => OPEN.has(r.status))
          .map((r) => ({
            id: r.id,
            service_code: r.serviceCode,
            status: r.status,
            requested_for_at: r.requestedForAt,
            created_at: r.createdAt,
          }));
      },
    };
  }

  private createRequest(): AiToolDefinition<{
    service_code: string;
    fields: Record<string, unknown>;
    requested_for_at?: string | null;
  }> {
    return {
      code: 'operations.create_service_request',
      description:
        'Creates a service request for the guest (use a code from catalog.list_services and fill its required fields). A repeated ask is linked to the open request instead of creating another.',
      risk: 'MEDIUM',
      requiredPermission: 'request.create',
      input: z
        .object({
          service_code: z.string().min(1).max(64),
          fields: z.record(z.string(), z.unknown()).default({}),
          requested_for_at: z.iso.datetime({ offset: true }).nullable().optional(),
        })
        .strict(),
      needs: { guest: true },
      handle: async (args, ctx) => {
        const g = guestOf(ctx);
        const created = await this.catalog.createServiceRequest({
          tenantId: ctx.tenantId,
          propertyId: ctx.propertyId,
          stayId: g.stayId,
          guestId: g.guestId,
          serviceCode: args.service_code,
          fields: args.fields,
          requestedForAt: args.requested_for_at ?? null,
          locale: ctx.locale,
          source: 'AI',
          conversationId: ctx.conversationId,
        });
        return {
          request_id: created.request.id,
          status: created.request.status,
          related_to_open_request: created.related,
        };
      },
    };
  }

  private cancelRequest(): AiToolDefinition<{ request_id: string; reason: string }> {
    const ownRequest = async (args: { request_id: string }, ctx: ToolContext) => {
      const request = await this.catalog.getServiceRequest(ctx.tenantId, args.request_id);
      if (!request || request.stayId !== guestOf(ctx).stayId || !OPEN.has(request.status))
        throw AppError.notFound('catalog.request.not_found');
    };
    return {
      code: 'operations.cancel_service_request',
      description:
        "Asks staff to cancel one of the guest's open requests (a person approves it first). Use an id from operations.find_open_requests.",
      risk: 'HIGH',
      requiredPermission: 'request.manage',
      input: z.object({ request_id: z.uuid(), reason: z.string().trim().min(1).max(500) }).strict(),
      needs: { guest: true },
      precheck: ownRequest,
      handle: async (args, ctx) => {
        await ownRequest(args, ctx);
        const cancelled = await this.catalog.cancelServiceRequest(
          ctx.tenantId,
          ctx.propertyId,
          args.request_id,
          args.reason,
        );
        return { request_id: cancelled.id, status: cancelled.status };
      },
    };
  }

  private sendMessage(): AiToolDefinition<{ body: string }> {
    return {
      code: 'communication.send_message',
      description:
        'Sends a message to the guest in this conversation, on the channel they use (write it in their language).',
      risk: 'LOW',
      requiredPermission: 'inbox.reply',
      input: z.object({ body: z.string().trim().min(1).max(2000) }).strict(),
      needs: { conversation: true },
      handle: async (args, ctx) => {
        const sent = await this.comms.replyAsAi({
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId!,
          agentCode: ctx.agentCode,
          body: args.body,
        });
        return { message_id: sent.messageId, delivery_status: sent.deliveryStatus };
      },
    };
  }
}
