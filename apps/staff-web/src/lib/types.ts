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
  /** The AI's suggested reply (ASSIST mode), until staff use it or the conversation moves on. */
  readonly aiDraft: {
    readonly id: string;
    readonly body: string;
    readonly agentCode: string;
    readonly createdAt: string;
  } | null;
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

// ---- housekeeping (see the housekeeping context's board and job services) ----

export type HousekeepingState =
  'DIRTY' | 'CLEANING' | 'CLEAN' | 'INSPECTING' | 'INSPECTED' | 'PICKUP';

export interface BoardRoom {
  readonly roomId: string;
  readonly roomNumber: string;
  readonly floorLabel: string | null;
  readonly occupancy: 'VACANT' | 'OCCUPIED' | null;
  readonly housekeeping: HousekeepingState | null;
  readonly frontOffice: string | null;
  readonly ready: boolean;
  readonly signals: ReadonlyArray<{ readonly signal: string; readonly source: string }>;
}

export interface HousekeepingJob {
  readonly id: string;
  readonly roomId: string;
  readonly roomNumber: string | null;
  readonly floorLabel: string | null;
  readonly cleaningType: string;
  readonly credits: number;
  readonly status: string;
  readonly taskId: string | null;
  readonly assignee: { readonly type: string; readonly id: string } | null;
  readonly makeUpRequested: boolean;
  readonly doNotDisturb: boolean;
}

export interface Attendant {
  readonly id: string;
  readonly displayName: string;
}

export interface AssignmentPlan {
  readonly day: string;
  readonly totalCredits: number;
  readonly plan: ReadonlyArray<{
    readonly attendantId: string;
    readonly credits: number;
    readonly jobs: ReadonlyArray<{ readonly jobId: string; readonly roomNumber: string }>;
  }>;
}

// ---- branding (see the organization context's branding resolver) ----

/** The hotel's resolved brand (platform → tenant → organization → property). */
export interface ResolvedBrand {
  readonly propertyId: string;
  readonly displayName: string;
  readonly primaryColor: string;
  readonly logoAssetKey: string | null;
}

/** The property's own brand layer and what everyone sees after inheritance. */
export interface PropertyBrand {
  readonly profile: {
    readonly displayName: string | null;
    readonly primaryColor: string | null;
    readonly logoAssetKey: string | null;
  } | null;
  readonly resolved: ResolvedBrand;
}

// ---- engineering (see the engineering context's work order, asset and copilot services) ----

export type WorkOrderStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

export interface WorkOrder {
  readonly id: string;
  readonly number: number;
  readonly type: string;
  readonly source: string;
  readonly status: WorkOrderStatus;
  readonly assetId: string | null;
  readonly locationId: string;
  readonly roomNumber: string | null;
  readonly assetNumber: string | null;
  readonly assetName: string | null;
  readonly reportedAt: string;
  readonly symptomCode: string | null;
  readonly diagnosis: string | null;
  readonly failureModeCode: string | null;
  readonly causeCode: string | null;
  readonly resolutionCode: string | null;
  readonly downtimeStartedAt: string | null;
  readonly downtimeEndedAt: string | null;
  readonly downtimeMinutes: number | null;
  readonly codingMissing: readonly string[];
  readonly version: number;
}

export interface FailureCode {
  readonly id: string;
  readonly kind: 'SYMPTOM' | 'FAILURE_MODE' | 'CAUSE' | 'RESOLUTION';
  readonly code: string;
  readonly active: boolean;
  readonly translations: ReadonlyArray<{ readonly locale: string; readonly name: string }>;
}

export interface Asset {
  readonly id: string;
  readonly assetNumber: string;
  readonly name: string;
  readonly locationId: string;
  readonly status: 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED';
  readonly criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly warrantyUntil: string | null;
}

export interface CopilotAnswer {
  readonly executionId: string;
  readonly outcome: 'ANSWERED' | 'DISABLED' | 'FAILED';
  readonly answer: string | null;
  readonly sources: ReadonlyArray<{
    readonly documentId: string;
    readonly title: string;
    readonly versionNo: number;
  }>;
}

// ---- arrivals (see the housekeeping context's arrival risk) ----

export type ArrivalRiskReason =
  | 'NO_ROOM_ASSIGNED'
  | 'ROOM_RESTRICTED'
  | 'ROOM_STILL_OCCUPIED'
  | 'ROOM_DIRTY'
  | 'ROOM_BEING_CLEANED'
  | 'AWAITING_INSPECTION'
  | 'OPEN_ENGINEERING_WORK'
  | 'URGENT_ENGINEERING_WORK'
  | 'ETA_SOON'
  | 'ETA_PASSED'
  | 'VIP_GUEST';

export interface ArrivalRisk {
  readonly stayId: string;
  readonly guestName: string | null;
  readonly vip: boolean;
  readonly eta: string | null;
  readonly roomNumber: string | null;
  readonly housekeeping: string | null;
  readonly ready: boolean;
  readonly score: number;
  readonly level: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly reasons: readonly ArrivalRiskReason[];
}
