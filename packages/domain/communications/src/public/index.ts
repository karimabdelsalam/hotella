/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

/** Something to tell a guest about their stay (Spec §25): rendered in their language, delivered on their channel. */
export interface GuestNotificationInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly stayId: string;
  readonly guestId: string;
  /** The guest's language (e.g. the language they asked in). */
  readonly locale: string;
  /** Locale key and ICU parameters of the message (CLAUDE.md rule 7). */
  readonly message: {
    readonly key: string;
    readonly params?: Readonly<Record<string, string | number>>;
  };
  /** The approved WhatsApp template used outside the 24-hour window (`service_update`…), with its parameters. */
  readonly template?: { readonly code: string; readonly parameters: readonly string[] } | null;
  /** The context telling it, e.g. `catalog` (shown as the system sender). */
  readonly source: string;
}

export interface GuestNotificationResult {
  readonly conversationId: string;
  readonly messageId: string;
  /** Where it goes beyond the guest web: WhatsApp when the guest has a verified number there. */
  readonly channelType: 'WHATSAPP' | 'GUEST_WEB';
}

/** What other contexts may ask of the Conversation Engine (rule 18: nobody sends through a provider directly). */
export interface CommunicationsPublicApi {
  /** Joins the caller's transaction. */
  notifyGuest(input: GuestNotificationInput): Promise<GuestNotificationResult>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const COMMUNICATIONS_API = Symbol.for('hotella.domain.communications.api');

export { COMMUNICATIONS_MANIFEST } from '../manifest';
