import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { RequirePermission } from '@hotella/platform-auth';
import { LicenseCatalogService } from '../application/catalog.service';
import { PlanService } from '../application/plan.service';
import {
  createDraftSchema,
  createPlanSchema,
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
