import { Injectable } from '@nestjs/common';
import { IdentityRepositories } from './infrastructure/repositories';
import type { IdentityPublicApi, StaffContact, StaffDevice, StaffMemberSummary } from './public';

@Injectable()
export class IdentityPublicApiService implements IdentityPublicApi {
  constructor(private readonly repo: IdentityRepositories) {}

  async getStaffMember(tenantId: string, userId: string): Promise<StaffMemberSummary | null> {
    const user = await this.repo.userInTenant({ tenantId }, userId);
    if (!user) return null;
    const person = await this.repo.personById(user.personId);
    return {
      id: user.id,
      tenantId: user.tenantId,
      displayName: [person?.givenName, person?.familyName].filter(Boolean).join(' ') || user.email,
      localePref: person?.localePref ?? null,
      status: user.status,
    };
  }

  usersWithPermission(
    tenantId: string,
    propertyId: string,
    permission: string,
  ): Promise<readonly string[]> {
    return this.repo.userIdsWithPermission(tenantId, propertyId, permission);
  }

  usersWithRole(
    tenantId: string,
    propertyId: string,
    roleCode: string,
  ): Promise<readonly string[]> {
    return this.repo.userIdsWithRole(tenantId, propertyId, roleCode);
  }

  async getStaffContact(tenantId: string, userId: string): Promise<StaffContact | null> {
    const user = await this.repo.userInTenant({ tenantId }, userId);
    if (!user || user.status !== 'ACTIVE') return null;
    const person = await this.repo.personById(user.personId);
    return {
      id: user.id,
      displayName: [person?.givenName, person?.familyName].filter(Boolean).join(' ') || user.email,
      email: user.email,
      locale: person?.localePref ?? null,
    };
  }

  async staffDevices(tenantId: string, userId: string): Promise<readonly StaffDevice[]> {
    const user = await this.repo.userInTenant({ tenantId }, userId);
    if (!user || user.status !== 'ACTIVE') return [];
    return (await this.repo.liveDevicesOfUser(tenantId, userId)).map((d) => ({
      id: d.id,
      platform: d.platform,
      pushToken: d.pushToken,
      locale: d.locale,
    }));
  }

  async revokeStaffDevice(tenantId: string, deviceId: string, reason: string): Promise<void> {
    await this.repo.revokeDevices({ id: deviceId, tenantId }, reason, new Date());
  }
}
