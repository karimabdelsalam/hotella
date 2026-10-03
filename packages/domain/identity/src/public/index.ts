/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
export interface StaffMemberSummary {
  readonly id: string;
  readonly tenantId: string | null;
  readonly displayName: string;
  readonly localePref: string | null;
  readonly status: 'INVITED' | 'ACTIVE' | 'DISABLED';
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
}
/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const IDENTITY_API = Symbol.for('hotella.domain.identity.api');
