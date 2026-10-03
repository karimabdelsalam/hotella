import { Injectable } from '@nestjs/common';
import { IdentityRepositories } from './infrastructure/repositories';
import type { IdentityPublicApi, StaffMemberSummary } from './public';

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
}
