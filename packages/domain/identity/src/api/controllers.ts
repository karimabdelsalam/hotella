import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  ActorStore,
  PropertyScoped,
  Public,
  RequirePermission,
  TenantScoped,
} from '@hotella/platform-auth';
import { RateLimit } from '@hotella/platform-http';
import { AuthService, type ClientMeta } from '../application/auth.service';
import { IdentityAdminService } from '../application/admin.service';
import {
  acceptInvitationSchema,
  createRoleSchema,
  createUserSchema,
  grantMembershipSchema,
  loginSchema,
  mfaActivateSchema,
  mfaVerifySchema,
  refreshSchema,
  replaceMembershipRolesSchema,
  replaceRolePermissionsSchema,
  updateUserStatusSchema,
} from '../application/dto';
import { ProfileService } from '../application/profile.service';

class LoginDto extends createZodDto(loginSchema) {}
class MfaVerifyDto extends createZodDto(mfaVerifySchema) {}
class MfaActivateDto extends createZodDto(mfaActivateSchema) {}
class RefreshDto extends createZodDto(refreshSchema) {}
class AcceptInvitationDto extends createZodDto(acceptInvitationSchema) {}
class CreateUserDto extends createZodDto(createUserSchema) {}
class UpdateUserStatusDto extends createZodDto(updateUserStatusSchema) {}
class GrantMembershipDto extends createZodDto(grantMembershipSchema) {}
class ReplaceMembershipRolesDto extends createZodDto(replaceMembershipRolesSchema) {}
class CreateRoleDto extends createZodDto(createRoleSchema) {}
class ReplaceRolePermissionsDto extends createZodDto(replaceRolePermissionsSchema) {}

function clientMeta(req: Request): ClientMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null };
}

/** Credential endpoints are rate limited per IP on top of the per-account lockout. */
const CREDENTIAL_LIMIT = { limit: 10, windowSeconds: 60, keyBy: 'ip' } as const;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly actors: ActorStore,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ ...CREDENTIAL_LIMIT, name: 'iam-login' })
  login(@Body() body: LoginDto, @Req() req: Request) {
    return this.auth.login(body, clientMeta(req));
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ ...CREDENTIAL_LIMIT, name: 'iam-mfa' })
  verifyMfa(@Body() body: MfaVerifyDto, @Req() req: Request) {
    return this.auth.verifyMfa(body, clientMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 30, windowSeconds: 60, keyBy: 'ip', name: 'iam-refresh' })
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(): Promise<void> {
    await this.auth.logout(this.actors.require());
  }

  @Public()
  @Post('invitations/accept')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ ...CREDENTIAL_LIMIT, name: 'iam-invitation' })
  acceptInvitation(@Body() body: AcceptInvitationDto) {
    return this.auth.acceptInvitation(body);
  }

  @Post('mfa/enroll')
  @HttpCode(HttpStatus.OK)
  enrollMfa() {
    return this.auth.enrollMfa(this.actors.require());
  }

  @Post('mfa/activate')
  @HttpCode(HttpStatus.OK)
  activateMfa(@Body() body: MfaActivateDto) {
    return this.auth.activateMfa(this.actors.require(), body.code);
  }
}

@Controller('me')
export class MeController {
  constructor(
    private readonly profile: ProfileService,
    private readonly actors: ActorStore,
  ) {}
  @Get()
  me() {
    return this.profile.me(this.actors.require());
  }
}

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly admin: IdentityAdminService) {}
  @Get()
  @RequirePermission('iam.role.manage')
  catalog() {
    return this.admin.permissionCatalog();
  }
}

@Controller('tenants/:tenantId')
@TenantScoped({ from: 'param' })
export class TenantIdentityController {
  constructor(private readonly admin: IdentityAdminService) {}

  @Get('users')
  @RequirePermission('iam.user.read')
  listUsers(@Param('tenantId') tenantId: string) {
    return this.admin.listUsers({ tenantId });
  }

  @Post('users')
  @RequirePermission('iam.user.manage')
  createUser(@Param('tenantId') tenantId: string, @Body() body: CreateUserDto) {
    return this.admin.createUser({ tenantId }, body);
  }

  @Get('users/:userId')
  @RequirePermission('iam.user.read')
  getUser(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    return this.admin.getUser({ tenantId }, userId);
  }

  @Patch('users/:userId/status')
  @RequirePermission('iam.user.manage')
  setStatus(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateUserStatusDto,
  ) {
    return this.admin.setStatus({ tenantId }, userId, body.status);
  }

  /** Property-level managers may grant memberships for their property (scope read from the body). */
  @Post('users/:userId/memberships')
  @PropertyScoped({ from: 'body', optional: true })
  @RequirePermission('iam.membership.manage')
  grantMembership(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() body: GrantMembershipDto,
  ) {
    return this.admin.grantMembership({ tenantId }, userId, body);
  }

  @Put('memberships/:membershipId/roles')
  @RequirePermission('iam.membership.manage', { checkedBy: 'gate' })
  replaceMembershipRoles(
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: ReplaceMembershipRolesDto,
  ) {
    return this.admin.replaceMembershipRoles({ tenantId }, membershipId, body.roleCodes);
  }

  @Delete('memberships/:membershipId')
  @RequirePermission('iam.membership.manage', { checkedBy: 'gate' })
  deactivateMembership(
    @Param('tenantId') tenantId: string,
    @Param('membershipId') membershipId: string,
  ) {
    return this.admin.deactivateMembership({ tenantId }, membershipId);
  }

  @Get('roles')
  @RequirePermission('iam.user.read')
  listRoles(@Param('tenantId') tenantId: string) {
    return this.admin.listRoles({ tenantId });
  }

  @Post('roles')
  @RequirePermission('iam.role.manage')
  createRole(@Param('tenantId') tenantId: string, @Body() body: CreateRoleDto) {
    return this.admin.createRole({ tenantId }, body);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermission('iam.role.manage')
  replaceRolePermissions(
    @Param('tenantId') tenantId: string,
    @Param('roleId') roleId: string,
    @Body() body: ReplaceRolePermissionsDto,
  ) {
    return this.admin.replaceRolePermissions({ tenantId }, roleId, body.permissions);
  }
}
