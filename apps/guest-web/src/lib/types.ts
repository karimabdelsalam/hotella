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
