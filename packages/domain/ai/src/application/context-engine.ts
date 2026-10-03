import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_API, type CatalogPublicApi } from '@hotella/domain-catalog/public';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
} from '@hotella/domain-communications/public';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import type { ContextProviderCode } from '../domain/agents';
import type { ClassifiedText, DataClass, GatewayMessage } from '../public';

export interface ContextRequest {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly guest: { readonly guestId: string; readonly stayId: string } | null;
  readonly conversationId: string | null;
  readonly locale: string;
  readonly providers: readonly ContextProviderCode[];
  readonly recentMessages: number;
}

export interface BuiltContext {
  /** Labelled system parts (each with its data class; the gateway filters them per provider). */
  readonly parts: readonly ClassifiedText[];
  /** The conversation so far, oldest first, ending with the guest's latest words. */
  readonly history: readonly GatewayMessage[];
  /** What was gathered (codes, counts, classes; never content), for the execution record. */
  readonly summary: ReadonlyArray<{
    readonly provider: ContextProviderCode;
    readonly items: number;
    readonly dataClass: DataClass;
  }>;
}

const OPEN = new Set(['OPEN', 'IN_PROGRESS']);

/** Context blocks are framed as data so instructions hidden in them are not followed (Spec §37). */
const block = (name: string, lines: readonly string[]) =>
  `<context name="${name}">\n${lines.join('\n')}\n</context>`;

/**
 * The Context Engine (Spec §35): an agent's context policy names providers; each returns the minimum the agent needs,
 * labelled with its data class (ADR-0018). Structured live data comes from the owning contexts' public APIs (and,
 * during the conversation, from tools) — never from retrieval.
 */
@Injectable()
export class ContextEngine {
  constructor(
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogPublicApi,
    @Inject(COMMUNICATIONS_API) private readonly comms: CommunicationsPublicApi,
  ) {}

  async build(req: ContextRequest, now = new Date()): Promise<BuiltContext> {
    const parts: ClassifiedText[] = [];
    const summary: Array<BuiltContext['summary'][number]> = [];
    let history: GatewayMessage[] = [];
    const add = (provider: ContextProviderCode, dataClass: DataClass, lines: string[]) => {
      summary.push({ provider, items: lines.length, dataClass });
      if (lines.length > 0) parts.push({ text: block(provider, lines), dataClass });
    };
    for (const provider of req.providers) {
      switch (provider) {
        case 'property.profile': {
          const p = await this.org.getProperty(req.tenantId, req.propertyId);
          if (!p) break;
          const local = new Intl.DateTimeFormat('en-GB', {
            timeZone: p.timezone,
            dateStyle: 'full',
            timeStyle: 'short',
          }).format(now);
          add(provider, 'INTERNAL', [`Hotel: ${p.name}`, `Local time: ${local}`]);
          break;
        }
        case 'guest.current_stay': {
          if (!req.guest) break;
          const stay = await this.guests.getStay(req.tenantId, req.guest.stayId);
          if (!stay) break;
          const member = (await this.guests.stayParty(req.tenantId, stay.id)).find(
            (m) => m.guestId === req.guest!.guestId,
          );
          const room = stay.currentRoomId
            ? await this.org.getRoom(req.tenantId, req.propertyId, stay.currentRoomId)
            : null;
          add(provider, 'CONFIDENTIAL', [
            `Guest first name: ${member?.givenName ?? 'unknown'}`,
            `Stay status: ${stay.status}`,
            `Room: ${room?.roomNumber ?? 'not assigned'}`,
            `Expected departure: ${stay.expectedDeparture}`,
          ]);
          break;
        }
        case 'catalog.services': {
          if (!req.guest) break;
          const services = await this.catalog.servicesForGuest({
            tenantId: req.tenantId,
            propertyId: req.propertyId,
            stayId: req.guest.stayId,
            guestId: req.guest.guestId,
            locale: req.locale,
          });
          add(
            provider,
            'INTERNAL',
            services.map((s) => `${s.code}: ${s.name}${s.openNow ? '' : ' (closed now)'}`),
          );
          break;
        }
        case 'catalog.open_requests': {
          if (!req.guest) break;
          const open = (
            await this.catalog.serviceRequestsOfStay(req.tenantId, req.guest.stayId)
          ).filter((r) => OPEN.has(r.status));
          add(
            provider,
            'CONFIDENTIAL',
            open.length > 0
              ? open.map((r) => `${r.id} ${r.serviceCode} ${r.status} since ${r.createdAt}`)
              : ['none'],
          );
          break;
        }
        case 'conversation.recent': {
          if (!req.conversationId) break;
          const messages = await this.comms.recentMessages(
            req.tenantId,
            req.conversationId,
            req.recentMessages,
          );
          history = messages.flatMap((m): GatewayMessage[] => {
            if (!m.body) return [];
            if (m.direction === 'INBOUND')
              return [{ role: 'user', content: m.body, dataClass: 'CONFIDENTIAL' }];
            const who = m.senderType === 'AI' ? '' : `(${m.senderType.toLowerCase()}) `;
            return [{ role: 'assistant', content: `${who}${m.body}`, dataClass: 'CONFIDENTIAL' }];
          });
          summary.push({ provider, items: history.length, dataClass: 'CONFIDENTIAL' });
          break;
        }
      }
    }
    return { parts, history, summary };
  }
}
