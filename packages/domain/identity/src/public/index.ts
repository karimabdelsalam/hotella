/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
export interface StaffMemberSummary {
  readonly id: string;
  readonly tenantId: string | null;
  readonly displayName: string;
  readonly localePref: string | null;
  readonly status: 'INVITED' | 'ACTIVE' | 'DISABLED';
}

/** How to reach a staff member (notification channels). E-mail is personal data: use it to deliver, never store it. */
export interface StaffContact {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly locale: string | null;
}

/** A phone where a staff member's notifications are pushed (ADR-0023). The token is CONFIDENTIAL: deliver, never log. */
export interface StaffDevice {
  readonly id: string;
  readonly platform: 'ANDROID' | 'IOS';
  readonly pushToken: string;
  readonly locale: string | null;
}

export interface IdentityPublicApi {
  /** Staff member as other contexts may show it (assignment pickers, audit views). Null when not in the tenant. */
  getStaffMember(tenantId: string, userId: string): Promise<StaffMemberSummary | null>;
  /** Users holding a permission at a property (e.g. who can be assigned a housekeeping task). */
  usersWithPermission(
    tenantId: string,
    propertyId: string,
    permission: string,
  ): Promise<readonly string[]>;
  /** Active users holding a role (by code) at a property, e.g. who to notify on an escalation. */
  usersWithRole(tenantId: string, propertyId: string, roleCode: string): Promise<readonly string[]>;
  /** Contact of an active staff member of the tenant; null otherwise. */
  getStaffContact(tenantId: string, userId: string): Promise<StaffContact | null>;
  /** Live devices of an active staff member (none when the person is not active in the tenant). */
  staffDevices(tenantId: string, userId: string): Promise<readonly StaffDevice[]>;
  /** The push provider no longer knows this device: stop using it. */
  revokeStaffDevice(tenantId: string, deviceId: string, reason: string): Promise<void>;
}
/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const IDENTITY_API = Symbol.for('hotella.domain.identity.api');
