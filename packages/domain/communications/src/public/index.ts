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

/** A conversation as the AI concierge sees it (who, where, and whether it may take part). */
export interface ConversationForAi {
  readonly id: string;
  readonly propertyId: string;
  readonly stayId: string | null;
  readonly guestId: string | null;
  readonly status: 'OPEN' | 'WAITING_GUEST' | 'WAITING_STAFF' | 'HANDED_OFF' | 'CLOSED';
  readonly aiMode: 'OFF' | 'ASSIST' | 'AUTO';
}

/** A guest-visible message of a conversation (the guest's words are CONFIDENTIAL). */
export interface ConversationMessage {
  readonly id: string;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly senderType: 'GUEST' | 'STAFF' | 'AI' | 'SYSTEM' | 'EXTERNAL';
  readonly body: string | null;
  readonly createdAt: string;
}

/** What other contexts may ask of the Conversation Engine (rule 18: nobody sends through a provider directly). */
export interface CommunicationsPublicApi {
  conversationForAi(tenantId: string, conversationId: string): Promise<ConversationForAi | null>;
  /** The latest guest-visible messages, oldest first. */
  recentMessages(
    tenantId: string,
    conversationId: string,
    limit: number,
  ): Promise<readonly ConversationMessage[]>;
  /**
   * ASSIST mode (Spec §23): the AI suggests a reply for staff instead of sending it; it replaces any pending
   * suggestion of the conversation. Refused once the conversation is closed or handed off.
   */
  saveDraft(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly agentCode: string;
    readonly executionId: string | null;
    readonly body: string;
  }): Promise<{ readonly draftId: string }>;
  /** Joins the caller's transaction. */
  notifyGuest(input: GuestNotificationInput): Promise<GuestNotificationResult>;
  /**
   * An AI agent's reply in a conversation (Spec §23): queued on the conversation's reply channel like a staff reply,
   * with the AI as sender. Refused when the conversation is closed or handed off to staff.
   */
  replyAsAi(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly agentCode: string;
    readonly body: string;
  }): Promise<{ readonly messageId: string; readonly deliveryStatus: string }>;
  /** Hands the conversation to staff with a reason (Spec §24): `HANDED_OFF`, AI mode off, the inbox is told. */
  handOff(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly reason: string;
  }): Promise<void>;
}

/**
 * Speech for the voice channel (BUILD_PLAN 13.4). Communications cannot depend on the AI context (AI depends on it), so
 * it declares this port and the AI context registers its Model Gateway implementation (`AUDIO` capability, audio is
 * SENSITIVE and stays on-prem unless the egress policy is opened, Q22). Without one, voice gateways must send text.
 */
export interface SpeechPort {
  transcribe(input: {
    readonly tenantId: string;
    readonly propertyId: string;
    readonly audio: Uint8Array;
    readonly mimeType: string;
    readonly language: string | null;
  }): Promise<{ readonly text: string; readonly language: string | null }>;
  synthesize(input: {
    readonly tenantId: string;
    readonly propertyId: string;
    readonly text: string;
    readonly language: string | null;
  }): Promise<{ readonly audio: Uint8Array; readonly mimeType: string }>;
}

export interface SpeechServices {
  /** One implementation per process; registering a second is a wiring error. */
  register(port: SpeechPort): void;
}

export const SPEECH_SERVICES = Symbol.for('hotella.domain.communications.speech');

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const COMMUNICATIONS_API = Symbol.for('hotella.domain.communications.api');

export { COMMUNICATIONS_MANIFEST } from '../manifest';
