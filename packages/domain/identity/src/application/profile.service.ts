import { HttpStatus, Injectable } from '@nestjs/common';
import type { RequestActor } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { MembershipPermissionResolver } from '../auth/permission-resolver';
import { IdentityRepositories } from '../infrastructure/repositories';
import {
  IdentityAdminService,
  type MembershipView,
  toUserView,
  type UserView,
} from './admin.service';

export interface MeView {
  user: UserView;
  /** Permissions that apply tenant-wide (or platform-wide for platform admins). */
  permissions: readonly string[];
  /** ACTIVE memberships with their roles and the effective permissions at that property. */
  memberships: Array<MembershipView & { permissions: readonly string[] }>;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly admin: IdentityAdminService,
    private readonly resolver: MembershipPermissionResolver,
  ) {}

  async me(actor: RequestActor): Promise<MeView> {
    const user = await this.repo.userById(actor.id);
    const person = user ? await this.repo.personById(user.personId) : undefined;
    if (!user || !person) throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);
    const memberships = (await this.admin.membershipViews(user.id, user.tenantId)).filter(
      (m) => m.status === 'ACTIVE',
    );
    const withPermissions = [];
    for (const m of memberships)
      withPermissions.push({
        ...m,
        permissions: await this.resolver.permissionsFor(actor, {
          tenantId: m.tenantId,
          propertyId: m.propertyId,
        }),
      });
    return {
      user: toUserView(user, person),
      permissions: await this.resolver.permissionsFor(actor, {
        tenantId: user.tenantId,
        propertyId: null,
      }),
      memberships: withPermissions,
    };
  }
}
