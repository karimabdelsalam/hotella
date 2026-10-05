/** Shapes of the guest API responses this app reads (communications, catalog and organization contexts). */

export interface Attribution {
  readonly show: boolean;
  readonly label: string;
  readonly href: string;
}

export interface Branding {
  readonly propertyId: string;
  readonly displayName: string;
  readonly logoAssetKey: string | null;
  readonly primaryColor: string;
  readonly welcomeText: string | null;
  readonly attribution: Attribution;
}

export interface Me {
  readonly guest: { readonly givenName: string | null; readonly locale: string | null };
  readonly stay: {
    readonly id: string;
    readonly status: string;
    readonly expectedDeparture: string;
    readonly room: { readonly number: string } | null;
  } | null;
  readonly scopes: readonly string[];
  readonly property: { readonly id: string; readonly name: string } | null;
  readonly branding: Branding | null;
}

export interface ServiceField {
  readonly code: string;
  readonly type: 'TEXT' | 'NUMBER' | 'CHOICE' | 'DATETIME' | 'BOOLEAN';
  readonly required: boolean;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly options?: ReadonlyArray<{ readonly code: string; readonly label: string }>;
}

export interface Service {
  readonly code: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly price: { readonly amountMinor: number; readonly currency: string } | null;
  readonly fields: readonly ServiceField[];
  readonly openNow: boolean;
  readonly allowScheduling: boolean;
}

export interface Catalog {
  readonly categories: ReadonlyArray<{
    readonly code: string;
    readonly icon: string | null;
    readonly name: string;
    readonly services: readonly Service[];
  }>;
}

export type RequestStatus = 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface GuestRequest {
  readonly id: string;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly status: RequestStatus;
  readonly relatedCount: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface Conversation {
  readonly conversation: { readonly id: string; readonly status: string } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly direction: 'INBOUND' | 'OUTBOUND';
    readonly senderType: 'GUEST' | 'STAFF' | 'AI' | 'SYSTEM' | 'EXTERNAL';
    readonly body: string | null;
    readonly createdAt: string;
  }>;
}

export interface GuestSitting {
  readonly sittingId: string;
  readonly startsAt: string;
  readonly seats: number;
  readonly booked: number;
  readonly free: number;
  /** Open for guests now (cut-off, days ahead) and enough seats for the smallest party. */
  readonly bookable: boolean;
}

export interface GuestRestaurant {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly dressCode: string | null;
  readonly minParty: number;
  readonly maxParty: number;
  /** Bookings this stay may make here (null: not limited). */
  readonly allowance: {
    readonly allowed: number | null;
    readonly used: number;
    readonly remaining: number | null;
  };
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly sittings: readonly GuestSitting[];
  }>;
}

export type ReservationStatus = 'CONFIRMED' | 'SEATED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface GuestReservation {
  readonly id: string;
  readonly restaurantId: string;
  readonly serviceDate: string;
  readonly startsAt: string;
  readonly partySize: number;
  readonly status: ReservationStatus;
  readonly restaurant: { readonly name: string } | null;
}
