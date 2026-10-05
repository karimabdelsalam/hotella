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
  supportAccessRequestSchema,
  supportAccessRevokeSchema,
  updateUserStatusSchema,
} from '../application/dto';
import { SupportAccessService } from '../application/support-access.service';
import { ProfileService } from '../application/profile.service';
import { DeviceService, registerDeviceSchema } from '../application/device.service';
import {
  ApiClientService,
  createApiClientSchema,
  revokeApiClientSchema,
} from '../application/api-client.service';

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
class SupportAccessRequestDto extends createZodDto(supportAccessRequestSchema) {}
class SupportAccessRevokeDto extends createZodDto(supportAccessRevokeSchema) {}
class CreateApiClientDto extends createZodDto(createApiClientSchema) {}
class RevokeApiClientDto extends createZodDto(revokeApiClientSchema) {}
class RegisterDeviceDto extends createZodDto(registerDeviceSchema) {}

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
    private readonly devices: DeviceService,
    private readonly actors: ActorStore,
  ) {}
  @Get()
  me() {
    return this.profile.me(this.actors.require());
  }

  /**
   * The Hotella app registers the phone of this session for push (ADR-0023). Self-service and bound to the session,
   * like sign-out and MFA enrolment: no permission beyond being a signed-in staff member; audited.
   */
  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: 20, windowSeconds: 60, keyBy: 'ip', name: 'iam-device' })
  registerDevice(@Body() body: RegisterDeviceDto) {
    return this.devices.register(this.actors.require(), body);
  }

  @Delete('devices/:deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeDevice(@Param('deviceId') deviceId: string): Promise<void> {
    await this.devices.unregister(this.actors.require(), deviceId);
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

@Controller('support-access')
export class SupportAccessController {
  constructor(private readonly support: SupportAccessService) {}
  /** A support engineer's own grants across tenants. */
  @Get('mine')
  mine() {
    return this.support.mine();
  }
}

@Controller('tenants/:tenantId')
@TenantScoped({ from: 'param' })
export class TenantIdentityController {
  constructor(
    private readonly admin: IdentityAdminService,
    private readonly support: SupportAccessService,
    private readonly apiClientService: ApiClientService,
  ) {}

  // ---- support access (Spec §64) ----
  @Post('support-access')
  @RequirePermission('support.access.request', { checkedBy: 'gate' })
  requestSupportAccess(@Param('tenantId') tenantId: string, @Body() body: SupportAccessRequestDto) {
    return this.support.request({ tenantId }, body);
  }

  @Get('support-access')
  @RequirePermission('support.access.approve', { checkedBy: 'gate' })
  listSupportAccess(@Param('tenantId') tenantId: string) {
    return this.support.listForTenant({ tenantId });
  }

  @Post('support-access/:grantId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('support.access.approve', { checkedBy: 'gate' })
  approveSupportAccess(@Param('tenantId') tenantId: string, @Param('grantId') grantId: string) {
    return this.support.approve({ tenantId }, grantId);
  }

  @Post('support-access/:grantId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('support.access.approve', { checkedBy: 'gate' })
  revokeSupportAccess(
    @Param('tenantId') tenantId: string,
    @Param('grantId') grantId: string,
    @Body() body: SupportAccessRevokeDto,
  ) {
    return this.support.revoke({ tenantId }, grantId, body.reason ?? null);
  }

  @Get('users')
  @RequirePermission('iam.user.read')
  listUsers(@Param('tenantId') tenantId: string) {
    return this.admin.listUsers({ tenantId });
  }

  // ---- API clients (Spec §75 developer platform) ----
  @Get('api-clients')
  @RequirePermission('iam.api_client.manage', { checkedBy: 'gate' })
  apiClients(@Param('tenantId') tenantId: string) {
    return this.apiClientService.list({ tenantId });
  }

  @Post('api-clients')
  @RequirePermission('iam.api_client.manage', { checkedBy: 'gate' })
  createApiClient(@Param('tenantId') tenantId: string, @Body() body: CreateApiClientDto) {
    return this.apiClientService.create({ tenantId }, body);
  }

  @Post('api-clients/:clientId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('iam.api_client.manage', { checkedBy: 'gate' })
  revokeApiClient(
    @Param('tenantId') tenantId: string,
    @Param('clientId') clientId: string,
    @Body() body: RevokeApiClientDto,
  ) {
    return this.apiClientService.revoke({ tenantId }, clientId, body.reason);
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
