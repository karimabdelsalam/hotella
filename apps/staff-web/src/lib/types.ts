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
  readonly user: {
    readonly id: string;
    readonly tenantId: string | null;
    readonly isPlatformAdmin?: boolean;
  };
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
  | 'INSPECTION_FAILED_TODAY'
  | 'RECURRING_FAILURE'
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

// ---- inspections (see the inspection context's template and inspection services) ----

export type ItemKind =
  'PASS_FAIL' | 'YES_NO' | 'SCORE' | 'NUMBER' | 'TEXT' | 'PHOTO' | 'MULTI_SELECT';
export type Severity = 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';

export interface ChecklistItem {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly help: string | null;
  readonly optionLabels: Readonly<Record<string, string>>;
  readonly rule: {
    readonly kind: ItemKind;
    readonly required: boolean;
    readonly scaleMax?: number;
    readonly min?: number;
    readonly max?: number;
    readonly options?: readonly string[];
    readonly failSeverity: Severity;
  };
}

export interface InspectionTemplate {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly scope: 'ROOM' | 'AREA' | 'ASSET';
  readonly publishedVersionNo: number | null;
}

export interface InspectionSummary {
  readonly id: string;
  readonly number: number;
  readonly templateName: string | null;
  readonly roomNumber: string | null;
  readonly status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  readonly result: 'PASS' | 'FAIL' | null;
  readonly score: number | null;
  readonly startedAt: string;
}

export interface InspectionDetail extends InspectionSummary {
  readonly checklist: {
    readonly sections: ReadonlyArray<{
      readonly id: string;
      readonly code: string;
      readonly title: string;
      readonly items: readonly ChecklistItem[];
    }>;
  };
  readonly answers: ReadonlyArray<{
    readonly itemCode: string;
    readonly answer: { readonly kind: ItemKind; readonly value: unknown };
  }>;
  readonly findings: ReadonlyArray<{
    readonly id: string;
    readonly itemCode: string;
    readonly severity: Severity;
    readonly status: 'OPEN' | 'LINKED' | 'RESOLVED';
  }>;
}

export interface RoomRow {
  readonly locationId: string;
  readonly roomNumber: string;
}

// ---- guest relations (see the relations context's complaint, candidate and recovery services) ----

export type ComplaintSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ComplaintStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type RecoveryKind =
  'APOLOGY' | 'AMENITY' | 'MEAL' | 'DISCOUNT' | 'REFUND' | 'ROOM_MOVE' | 'OTHER';

export interface ComplaintCategory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly defaultSeverity: ComplaintSeverity;
  readonly active: boolean;
}

export interface ComplaintSummary {
  readonly id: string;
  readonly number: number;
  readonly categoryName: string;
  readonly severity: ComplaintSeverity;
  readonly status: ComplaintStatus;
  readonly source: 'STAFF' | 'GUEST_WEB' | 'CHAT' | 'AI_CANDIDATE' | 'SURVEY';
  readonly summary: string;
  readonly openedAt: string;
  readonly version: number;
}

export interface ComplaintDetail extends ComplaintSummary {
  readonly description: string | null;
  readonly roomNumber: string | null;
  readonly stayId: string | null;
  readonly evidence: ReadonlyArray<{
    readonly id: string;
    readonly kind: 'MESSAGE' | 'NOTE' | 'PHOTO' | 'AI_REASON';
    readonly text: string | null;
    readonly createdAt: string;
  }>;
  readonly history: ReadonlyArray<{
    readonly id: string;
    readonly fromStatus: ComplaintStatus | null;
    readonly toStatus: ComplaintStatus;
    readonly note: string | null;
    readonly createdAt: string;
  }>;
  readonly recovery: ReadonlyArray<{
    readonly id: string;
    readonly kind: RecoveryKind;
    readonly amountMinor: number | null;
    readonly currency: string | null;
    readonly note: string | null;
    readonly status: 'DONE' | 'PENDING_APPROVAL' | 'REJECTED';
  }>;
}

export interface ComplaintCandidate {
  readonly id: string;
  readonly categoryName: string;
  readonly severity: ComplaintSeverity;
  readonly confidence: number;
  readonly summary: string;
  readonly reason: string;
  readonly guestWords: string | null;
  readonly createdAt: string;
  readonly version: number;
}

// ---- lost & found (see the lostfound context's item service) ----

export type LostFoundStatus = 'REGISTERED' | 'MATCHED' | 'CLAIMED' | 'RELEASED' | 'DISPOSED';

export interface LostFoundItem {
  readonly id: string;
  readonly number: number;
  readonly kind: 'FOUND' | 'LOST';
  readonly category: string;
  readonly colour: string | null;
  readonly brand: string | null;
  readonly description: string;
  readonly roomNumber: string | null;
  readonly placeNote: string | null;
  readonly occurredAt: string;
  readonly storageLocation: string | null;
  readonly photoKeys: readonly string[];
  readonly valuable: boolean;
  readonly status: LostFoundStatus;
  readonly retentionUntil: string | null;
  readonly retentionDue: boolean;
  readonly version: number;
}

export interface LostFoundMatch {
  readonly id: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly status: 'PROPOSED' | 'CONFIRMED' | 'REJECTED';
  readonly version: number;
  readonly found: LostFoundItem;
  readonly lost: LostFoundItem;
}

export interface LostFoundDetail extends LostFoundItem {
  readonly ai: {
    readonly objectType: string | null;
    readonly colours: readonly string[];
    readonly brand: string | null;
  } | null;
  /** What a vision model read from each photo (only when the property turned it on, BUILD_PLAN 9.5). */
  readonly vision?: ReadonlyArray<{
    readonly photo: string;
    readonly objectType: string | null;
    readonly category: string | null;
    readonly description: string | null;
    readonly colours: readonly string[];
    readonly material: string | null;
    readonly brand: string | null;
  }>;
  /** Other open found items that may be the same object handed in twice. */
  readonly possibleDuplicates?: ReadonlyArray<{
    readonly score: number;
    readonly reasons: readonly string[];
    readonly item: LostFoundItem;
  }>;
  readonly matches: ReadonlyArray<{
    readonly id: string;
    readonly score: number;
    readonly reasons: readonly string[];
    readonly status: 'PROPOSED' | 'CONFIRMED' | 'REJECTED';
    readonly other: LostFoundItem;
  }>;
  readonly claim: {
    readonly claimantName: string;
    readonly idDocument: string;
    readonly handover: string;
    readonly releasedAt: string;
  } | null;
  readonly history: ReadonlyArray<{
    readonly id: string;
    readonly event: string;
    readonly note: string | null;
    readonly createdAt: string;
  }>;
}

// ---- logbook (see the logbook context's service) ----

export type ShiftName = 'MORNING' | 'EVENING' | 'NIGHT';

export interface DepartmentRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export interface HandoverFacts {
  readonly work: { readonly open: number; readonly urgent: number; readonly overdue: number };
  readonly complaints: { readonly open: number; readonly high_or_critical: number } | null;
  readonly rooms_out_of_order: ReadonlyArray<{
    readonly room: string;
    readonly kind: string;
  }> | null;
  readonly lost_found: {
    readonly found_waiting: number;
    readonly lost_reports_open: number;
    readonly matches_to_decide: number;
    readonly past_retention: number;
  } | null;
  readonly entries: { readonly total: number; readonly incidents: number };
}

export interface Handover {
  readonly id: string;
  readonly departmentCode: string;
  readonly shiftDate: string;
  readonly shift: ShiftName;
  readonly summary: string;
  readonly facts: HandoverFacts;
  readonly source: 'AI' | 'WRITTEN';
  readonly edited: boolean;
  readonly status: 'DRAFT' | 'ACKNOWLEDGED';
  readonly draftedById: string | null;
  readonly acknowledgedAt: string | null;
  readonly version: number;
}

export interface ShiftView {
  readonly departmentCode: string;
  readonly shiftDate: string;
  readonly shift: ShiftName;
  readonly window: { readonly from: string; readonly to: string };
  readonly facts: HandoverFacts;
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly kind: 'NOTE' | 'INCIDENT' | 'HANDOVER_ITEM';
    readonly text: string;
    readonly roomNumber: string | null;
    readonly correctsEntryId: string | null;
    readonly createdAt: string;
  }>;
  readonly handover: Handover | null;
}

// ---- restaurant (Spec Appendix B.1) ----

export type RestaurantStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE';
export type TableStatus = 'CONFIRMED' | 'SEATED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface RestaurantView {
  readonly id: string;
  readonly code: string;
  readonly status: RestaurantStatus;
  readonly name: string;
  readonly description: string | null;
  readonly dressCode: string | null;
  readonly minParty: number;
  readonly maxParty: number;
  readonly bookDaysAhead: number;
  readonly guestCutoffMinutes: number;
  readonly allowanceApplies: boolean;
  readonly version: number;
}

export interface RestaurantDetail extends RestaurantView {
  readonly translations: ReadonlyArray<{
    readonly locale: string;
    readonly name: string;
    readonly description: string | null;
    readonly dressCode: string | null;
  }>;
  readonly sittings: ReadonlyArray<{
    readonly id: string;
    readonly weekday: number;
    readonly startsAt: string;
    readonly seats: number;
    readonly validFrom: string;
  }>;
  readonly closures: ReadonlyArray<{
    readonly id: string;
    readonly onDate: string;
    readonly sittingId: string | null;
    readonly reason: string;
  }>;
}

export interface SittingLoad {
  readonly sittingId: string;
  readonly startsAt: string;
  readonly seats: number;
  readonly booked: number;
  readonly free: number;
}

export interface TableReservation {
  readonly id: string;
  readonly restaurantId: string;
  readonly sittingId: string;
  readonly serviceDate: string;
  readonly startsAt: string;
  readonly partySize: number;
  readonly roomNumber: string | null;
  readonly guestName: string | null;
  readonly status: TableStatus;
  readonly channel: 'GUEST_APP' | 'STAFF' | 'AI';
  readonly notes: string | null;
  readonly overridden: boolean;
  readonly version: number;
}

export interface RestaurantBoard extends RestaurantView {
  readonly sittings: ReadonlyArray<
    SittingLoad & { readonly reservations: readonly TableReservation[] }
  >;
}

export interface RestaurantAvailability extends RestaurantView {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly sittings: readonly SittingLoad[];
  }>;
}

export interface StayForBooking {
  readonly stayId: string;
  readonly status: string;
  readonly roomNumber: string;
  readonly guestName: string | null;
  readonly partySize: number;
  readonly arrival: string;
  readonly departure: string;
  readonly nights: number;
  readonly allowance: ReadonlyArray<{
    readonly restaurantId: string;
    readonly name: string;
    readonly allowed: number | null;
    readonly used: number;
    readonly remaining: number | null;
  }>;
}

// ---- intelligence (see the AI context's insight, pulse and quality services, BUILD_PLAN 12.4–12.6) ----

export interface Insight {
  readonly id: string;
  readonly detector: string;
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly confidence: number;
  readonly reasonKey: string;
  readonly reasonParams: Readonly<Record<string, string | number>>;
  readonly affected: ReadonlyArray<{ readonly type: string; readonly id: string }>;
  readonly suggestedAction: {
    readonly key: string;
    readonly params: Readonly<Record<string, string | number>>;
  } | null;
  readonly status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED' | 'EXPIRED';
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrences: number;
  readonly version: number;
}

export interface Pulse {
  readonly at: string;
  readonly openWork: {
    readonly total: number;
    readonly byDepartment: Readonly<Record<string, number>>;
  };
  readonly slaBreaches24h: {
    readonly total: number;
    readonly byDepartment: Readonly<Record<string, number>>;
  };
  readonly openComplaints: {
    readonly total: number;
    readonly bySeverity: Readonly<Record<string, number>>;
  };
  readonly roomsRestricted: {
    readonly total: number;
    readonly byKind: Readonly<Record<string, number>>;
  };
  readonly arrivalsTomorrow: { readonly day: string; readonly count: number };
  readonly liveInsights: {
    readonly total: number;
    readonly bySeverity: Readonly<Record<string, number>>;
  };
}

export interface QualityRow {
  readonly day: string;
  readonly agentCode: string;
  readonly agentVersionId: string | null;
  readonly metric: string;
  readonly value: number;
  readonly samples: number;
}

export interface ManagerAnswer {
  readonly executionId: string;
  readonly outcome: 'ANSWERED' | 'DISABLED' | 'FAILED';
  readonly answer: string | null;
}

// ---- building telemetry (see engineering's telemetry service, BUILD_PLAN 13.2) ----

export type TelemetryQuantity =
  | 'TEMPERATURE'
  | 'HUMIDITY'
  | 'POWER'
  | 'ENERGY'
  | 'WATER_FLOW'
  | 'PRESSURE'
  | 'CO2'
  | 'OCCUPANCY'
  | 'DOOR'
  | 'LEAK'
  | 'ALARM'
  | 'OTHER';

export interface TelemetryPoint {
  readonly id: string;
  readonly externalCode: string;
  readonly name: string | null;
  readonly assetId: string | null;
  readonly locationId: string | null;
  readonly quantity: TelemetryQuantity;
  readonly unit: string;
  readonly status: 'ACTIVE' | 'IGNORED';
  readonly lastValue: number | null;
  readonly lastAt: string | null;
  readonly version: number;
}

export interface TelemetryRule {
  readonly id: string;
  readonly pointId: string;
  readonly kind: 'THRESHOLD' | 'RATE' | 'STUCK' | 'MISSING';
  readonly severity: 'WARNING' | 'CRITICAL';
  readonly action: 'ALERT' | 'WORK_ORDER';
  readonly status: 'ACTIVE' | 'RETIRED';
}

export interface TelemetryAlarm {
  readonly id: string;
  readonly pointId: string;
  readonly ruleId: string;
  readonly status: 'OPEN' | 'ACKNOWLEDGED' | 'CLEARED';
  readonly raisedAt: string;
  readonly value: number | null;
  readonly peak: number | null;
  readonly workOrderId: string | null;
  readonly version: number;
}
