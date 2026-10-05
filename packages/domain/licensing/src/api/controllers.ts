import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { PropertyScoped, Public, RequirePermission, TenantScoped } from '@hotella/platform-auth';
import { LicenseCatalogService } from '../application/catalog.service';
import { ControlPlaneService } from '../application/control.service';
import { GrantService } from '../application/grant.service';
import { InstallationService } from '../application/installation.service';
import { LicenseViewService } from '../application/license-view.service';
import { SubscriptionService } from '../application/subscription.service';
import { PlanService } from '../application/plan.service';
import {
  attributionSchema,
  bundleRequestSchema,
  createInstallationSchema,
  changeSubscriptionSchema,
  createDraftSchema,
  createGrantSchema,
  createOverrideSchema,
  createPlanSchema,
  createSubscriptionSchema,
  entitlementQuerySchema,
  usageQuerySchema,
  revokeSchema,
  setFlagSchema,
  transitionSubscriptionSchema,
  updateDraftSchema,
  updatePlanSchema,
  versionActionSchema,
} from '../application/schemas';

class CreateLicensePlanDto extends createZodDto(createPlanSchema) {}
class UpdateLicensePlanDto extends createZodDto(updatePlanSchema) {}
class CreatePlanDraftDto extends createZodDto(createDraftSchema) {}
class UpdatePlanDraftDto extends createZodDto(updateDraftSchema) {}
class PlanVersionActionDto extends createZodDto(versionActionSchema) {}

/** The commercial catalog and plans (control plane, Spec §63; platform administrators). */
@Controller('control/license')
export class LicenseCatalogController {
  constructor(
    private readonly catalog: LicenseCatalogService,
    private readonly plans: PlanService,
  ) {}

  @Get('catalog')
  @RequirePermission('license.catalog.read', { checkedBy: 'gate' })
  list() {
    return this.catalog.list();
  }

  @Get('plans')
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  listPlans() {
    return this.plans.list();
  }

  @Post('plans')
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  createPlan(@Body() body: CreateLicensePlanDto) {
    return this.plans.create(body);
  }

  @Get('plans/:planId')
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  plan(@Param('planId') planId: string) {
    return this.plans.get(planId);
  }

  @Patch('plans/:planId')
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  updatePlan(@Param('planId') planId: string, @Body() body: UpdateLicensePlanDto) {
    return this.plans.update(planId, body);
  }

  @Post('plans/:planId/versions')
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  createDraft(@Param('planId') planId: string, @Body() body: CreatePlanDraftDto) {
    return this.plans.createDraft(planId, body);
  }

  @Put('plans/:planId/versions/:versionId')
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  updateDraft(
    @Param('planId') planId: string,
    @Param('versionId') versionId: string,
    @Body() body: UpdatePlanDraftDto,
  ) {
    return this.plans.updateDraft(planId, versionId, body);
  }

  @Post('plans/:planId/versions/:versionId/publish')
  @HttpCode(200)
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  publish(
    @Param('planId') planId: string,
    @Param('versionId') versionId: string,
    @Body() body: PlanVersionActionDto,
  ) {
    return this.plans.publish(planId, versionId, body);
  }

  @Post('plans/:planId/versions/:versionId/retire')
  @HttpCode(200)
  @RequirePermission('license.plan.manage', { checkedBy: 'gate' })
  retire(
    @Param('planId') planId: string,
    @Param('versionId') versionId: string,
    @Body() body: PlanVersionActionDto,
  ) {
    return this.plans.retire(planId, versionId, body);
  }
}

class CreateSubscriptionDto extends createZodDto(createSubscriptionSchema) {}
class TransitionSubscriptionDto extends createZodDto(transitionSubscriptionSchema) {}
class ChangeSubscriptionDto extends createZodDto(changeSubscriptionSchema) {}
class CreateEntitlementGrantDto extends createZodDto(createGrantSchema) {}
class CreateLimitOverrideDto extends createZodDto(createOverrideSchema) {}
class LicenseRevokeDto extends createZodDto(revokeSchema) {}
class EntitlementQueryDto extends createZodDto(entitlementQuerySchema) {}
class UsageReportQueryDto extends createZodDto(usageQuerySchema) {}

/** A tenant's subscriptions, grants and limit overrides (control plane; platform administrators). */
@Controller('control/tenants/:tenantId')
@TenantScoped({ from: 'param' })
export class TenantLicenseController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly grants: GrantService,
    private readonly views: LicenseViewService,
  ) {}

  @Get('subscriptions')
  @RequirePermission('license.subscription.manage', { checkedBy: 'gate' })
  listSubscriptions(@Param('tenantId') tenantId: string) {
    return this.subscriptions.list({ tenantId });
  }

  @Post('subscriptions')
  @RequirePermission('license.subscription.manage', { checkedBy: 'gate' })
  createSubscription(@Param('tenantId') tenantId: string, @Body() body: CreateSubscriptionDto) {
    return this.subscriptions.create({ tenantId }, body);
  }

  @Get('subscriptions/:subscriptionId')
  @RequirePermission('license.subscription.manage', { checkedBy: 'gate' })
  subscription(@Param('tenantId') tenantId: string, @Param('subscriptionId') id: string) {
    return this.subscriptions.get({ tenantId }, id);
  }

  @Post('subscriptions/:subscriptionId/transition')
  @HttpCode(200)
  @RequirePermission('license.subscription.manage', { checkedBy: 'gate' })
  transition(
    @Param('tenantId') tenantId: string,
    @Param('subscriptionId') id: string,
    @Body() body: TransitionSubscriptionDto,
  ) {
    return this.subscriptions.transition({ tenantId }, id, body);
  }

  @Post('subscriptions/:subscriptionId/change')
  @HttpCode(200)
  @RequirePermission('license.subscription.manage', { checkedBy: 'gate' })
  change(
    @Param('tenantId') tenantId: string,
    @Param('subscriptionId') id: string,
    @Body() body: ChangeSubscriptionDto,
  ) {
    return this.subscriptions.change({ tenantId }, id, body);
  }

  @Get('grants')
  @RequirePermission('license.grant.manage', { checkedBy: 'gate' })
  listGrants(@Param('tenantId') tenantId: string) {
    return this.grants.listGrants({ tenantId });
  }

  @Post('grants')
  @RequirePermission('license.grant.manage', { checkedBy: 'gate' })
  createGrant(@Param('tenantId') tenantId: string, @Body() body: CreateEntitlementGrantDto) {
    return this.grants.createGrant({ tenantId }, body);
  }

  @Post('grants/:grantId/revoke')
  @HttpCode(200)
  @RequirePermission('license.grant.manage', { checkedBy: 'gate' })
  revokeGrant(
    @Param('tenantId') tenantId: string,
    @Param('grantId') id: string,
    @Body() body: LicenseRevokeDto,
  ) {
    return this.grants.revokeGrant({ tenantId }, id, body);
  }

  @Get('limit-overrides')
  @RequirePermission('license.grant.manage', { checkedBy: 'gate' })
  listOverrides(@Param('tenantId') tenantId: string) {
    return this.grants.listOverrides({ tenantId });
  }

  @Post('limit-overrides')
  @RequirePermission('license.grant.manage', { checkedBy: 'gate' })
  createOverride(@Param('tenantId') tenantId: string, @Body() body: CreateLimitOverrideDto) {
    return this.grants.createOverride({ tenantId }, body);
  }

  @Post('limit-overrides/:overrideId/revoke')
  @HttpCode(200)
  @RequirePermission('license.grant.manage', { checkedBy: 'gate' })
  revokeOverride(
    @Param('tenantId') tenantId: string,
    @Param('overrideId') id: string,
    @Body() body: LicenseRevokeDto,
  ) {
    return this.grants.revokeOverride({ tenantId }, id, body);
  }

  @Get('usage')
  @RequirePermission('license.usage.read', { checkedBy: 'gate' })
  usage(@Param('tenantId') tenantId: string, @Query() query: UsageReportQueryDto) {
    return this.views.usage({ tenantId }, query);
  }

  @Get('entitlements')
  @RequirePermission('license.entitlement.read', { checkedBy: 'gate' })
  entitlements(@Param('tenantId') tenantId: string, @Query() query: EntitlementQueryDto) {
    return this.views.effective({ tenantId }, query.propertyId ?? null);
  }
}

/** A tenant's own licence, read-only (its managers). */
@Controller('tenants/:tenantId')
@TenantScoped({ from: 'param' })
export class TenantOwnLicenseController {
  constructor(private readonly views: LicenseViewService) {}

  @Get('license')
  @RequirePermission('license.tenant.read', { checkedBy: 'gate' })
  license(@Param('tenantId') tenantId: string) {
    return this.views.tenantLicense({ tenantId });
  }
}

/** The entitled codes for the signed-in staff member's property, so the apps offer only what may be used. */
@Controller('me')
export class MyEntitlementsController {
  constructor(private readonly views: LicenseViewService) {}

  @Get('entitlements')
  @PropertyScoped({ from: 'query', optional: true })
  mine(@Query() query: EntitlementQueryDto) {
    return this.views.mine(query.propertyId ?? null);
  }
}

class AttributionDto extends createZodDto(attributionSchema) {}
class SetFeatureFlagDto extends createZodDto(setFlagSchema) {}

/** The rest of the control plane: tenant overview, white-label attribution, feature flags (Spec §63). */
@Controller('control')
export class ControlPlaneController {
  constructor(private readonly control: ControlPlaneService) {}

  @Get('subscriptions')
  @RequirePermission('license.subscription.manage', { checkedBy: 'gate' })
  subscriptions() {
    return this.control.subscriptions();
  }

  @Get('tenants/:tenantId/attribution')
  @TenantScoped({ from: 'param' })
  @RequirePermission('license.attribution.manage', { checkedBy: 'gate' })
  attribution(@Param('tenantId') tenantId: string) {
    return this.control.attributionOf({ tenantId });
  }

  @Put('tenants/:tenantId/attribution')
  @TenantScoped({ from: 'param' })
  @RequirePermission('license.attribution.manage', { checkedBy: 'gate' })
  setAttribution(@Param('tenantId') tenantId: string, @Body() body: AttributionDto) {
    return this.control.setAttribution({ tenantId }, body);
  }

  @Get('feature-flags')
  @RequirePermission('platform.feature_flag.read', { checkedBy: 'gate' })
  flags() {
    return this.control.listFlags();
  }

  @Put('feature-flags')
  @RequirePermission('platform.feature_flag.manage', { checkedBy: 'gate' })
  setFlag(@Body() body: SetFeatureFlagDto) {
    return this.control.setFlag(body);
  }
}

class CreateInstallationDto extends createZodDto(createInstallationSchema) {}
class BundleRequestDto extends createZodDto(bundleRequestSchema) {}

/** Hotel-site installations of a tenant (ADR-0021; control plane, platform administrators). */
@Controller('control/tenants/:tenantId/installations')
@TenantScoped({ from: 'param' })
export class InstallationController {
  constructor(private readonly installations: InstallationService) {}

  @Get()
  @RequirePermission('license.installation.manage', { checkedBy: 'gate' })
  list(@Param('tenantId') tenantId: string) {
    return this.installations.list({ tenantId });
  }

  @Post()
  @RequirePermission('license.installation.manage', { checkedBy: 'gate' })
  register(@Param('tenantId') tenantId: string, @Body() body: CreateInstallationDto) {
    return this.installations.register({ tenantId }, body);
  }

  @Post(':installationId/revoke')
  @HttpCode(200)
  @RequirePermission('license.installation.manage', { checkedBy: 'gate' })
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('installationId') id: string,
    @Body() body: LicenseRevokeDto,
  ) {
    return this.installations.revoke({ tenantId }, id, body);
  }
}

/** The key sites pin to verify their bundles (control plane). */
@Controller('control/license/bundle-key')
export class BundleKeyController {
  constructor(private readonly installations: InstallationService) {}

  @Get()
  @RequirePermission('license.installation.manage', { checkedBy: 'gate' })
  key() {
    return this.installations.bundleKey();
  }
}

/** A site installation fetches its signed entitlement bundle; its own Ed25519 signature authenticates it. */
@Public()
@Controller('license/bundle')
export class SiteBundleController {
  constructor(private readonly installations: InstallationService) {}

  @Post()
  @HttpCode(200)
  bundle(@Body() body: BundleRequestDto) {
    return this.installations.issue(body);
  }
}
