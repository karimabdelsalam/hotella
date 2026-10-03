/** Shapes of the API responses the inbox reads (see the communications context's inbox service). */
export type ConversationStatus =
  'OPEN' | 'WAITING_GUEST' | 'WAITING_STAFF' | 'HANDED_OFF' | 'CLOSED';

export interface ConversationSummary {
  readonly id: string;
  readonly status: ConversationStatus;
  readonly aiMode: 'OFF' | 'ASSIST' | 'AUTO';
  readonly replyChannelType: string;
  readonly assignedUserId: string | null;
  readonly version: number;
  readonly lastMessageAt: string;
  readonly verified: boolean;
  readonly contact: string | null;
  readonly guest: {
    readonly id: string;
    readonly givenName: string;
    readonly familyName: string | null;
  } | null;
  readonly stay: {
    readonly id: string;
    readonly status: string;
    readonly expectedDeparture: string;
    readonly room: { readonly id: string; readonly number: string } | null;
  } | null;
  readonly lastMessage?: {
    readonly direction: string;
    readonly preview: string;
    readonly at: string;
  } | null;
}

export interface ThreadMessage {
  readonly id: string;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly senderType: 'GUEST' | 'STAFF' | 'AI' | 'SYSTEM' | 'EXTERNAL';
  readonly channelType: string;
  readonly type: string;
  readonly body: string | null;
  readonly deliveryStatus: string;
  readonly guestVisible: boolean;
  readonly createdAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  readonly openWork: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly status: string;
    readonly priority: string;
  }>;
  readonly messages: readonly ThreadMessage[];
}

export interface Me {
  readonly user: { readonly id: string; readonly tenantId: string | null };
  readonly memberships: ReadonlyArray<{
    readonly propertyId: string | null;
    readonly permissions: readonly string[];
  }>;
}

export interface PropertySummary {
  readonly id: string;
  readonly name: string;
}
