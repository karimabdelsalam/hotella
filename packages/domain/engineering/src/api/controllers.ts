import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  AssetService,
  createAssetModelSchema,
  createAssetSchema,
  createAssetTypeSchema,
  createFailureCodeSchema,
  linkDocumentSchema,
  listAssetsSchema,
  listFailureCodesSchema,
  updateAssetSchema,
  updateAssetTypeSchema,
} from '../application/asset.service';
import {
  completeWorkOrderSchema,
  createPartSchema,
  createWorkOrderSchema,
  fromRequestSchema,
  listWorkOrdersSchema,
  receivePartSchema,
  updateWorkOrderSchema,
  usePartSchema,
  warrantyDecisionSchema,
  WorkOrderService,
} from '../application/work-order.service';
import {
  createMeterSchema,
  createPlanSchema,
  createProcedureSchema,
  draftVersionSchema,
  MaintenanceService,
  readingSchema,
  updatePlanSchema,
} from '../application/maintenance.service';
import { askCopilotSchema, CopilotService } from '../application/copilot.service';
import {
  createPointSchema,
  createRuleSchema,
  minutesQuerySchema,
  TelemetryService,
  updatePointSchema,
  versionSchema,
} from '../application/telemetry.service';
import {
  createRestrictionSchema,
  listRestrictionsSchema,
  RestrictionService,
} from '../application/restriction.service';

class AskCopilotDto extends createZodDto(askCopilotSchema) {}
class CreatePointDto extends createZodDto(createPointSchema) {}
class UpdatePointDto extends createZodDto(updatePointSchema) {}
class CreateRuleDto extends createZodDto(createRuleSchema) {}
class TelemetryVersionDto extends createZodDto(versionSchema) {}
class MinutesQueryDto extends createZodDto(minutesQuerySchema) {}
class AlarmsQueryDto extends createZodDto(
  z.object({ live: z.enum(['true', 'false']).optional(), pointId: z.uuid().optional() }),
) {}
class CreateAssetTypeDto extends createZodDto(createAssetTypeSchema) {}
class UpdateAssetTypeDto extends createZodDto(updateAssetTypeSchema) {}
class CreateAssetModelDto extends createZodDto(createAssetModelSchema) {}
class CreateAssetDto extends createZodDto(createAssetSchema) {}
class UpdateAssetDto extends createZodDto(updateAssetSchema) {}
class ListAssetsDto extends createZodDto(listAssetsSchema) {}
class LinkDocumentDto extends createZodDto(linkDocumentSchema) {}
class CreateFailureCodeDto extends createZodDto(createFailureCodeSchema) {}
class ListFailureCodesDto extends createZodDto(listFailureCodesSchema) {}

/** Tenant-wide engineering reference data: asset types, models and the failure taxonomy (Spec §10.2, §10.5). */
@Controller('eng')
export class EngineeringReferenceController {
  constructor(
    private readonly assets: AssetService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope() {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.tenant.not_found');
    return { tenantId };
  }

  @Get('asset-types')
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  assetTypes() {
    return this.assets.listAssetTypes(this.scope());
  }

  @Post('asset-types')
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  createAssetType(@Body() body: CreateAssetTypeDto) {
    return this.assets.createAssetType(this.scope(), body);
  }

  @Patch('asset-types/:id')
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  updateAssetType(@Param('id') id: string, @Body() body: UpdateAssetTypeDto) {
    return this.assets.updateAssetType(this.scope(), id, body);
  }

  @Get('asset-models')
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  assetModels(@Query('assetTypeId') assetTypeId?: string) {
    return this.assets.listAssetModels(this.scope(), assetTypeId);
  }

  @Post('asset-models')
  @RequirePermission('eng.asset.manage', { checkedBy: 'gate' })
  createAssetModel(@Body() body: CreateAssetModelDto) {
    return this.assets.createAssetModel(this.scope(), body);
  }

  @Get('failure-codes')
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  failureCodes(@Query() query: ListFailureCodesDto) {
    return this.assets.listFailureCodes(this.scope(), query.kind);
  }

  @Post('failure-codes')
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  createFailureCode(@Body() body: CreateFailureCodeDto) {
    return this.assets.createFailureCode(this.scope(), body);
  }

  @Post('failure-codes/starter')
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  importStarter() {
    return this.assets.importStarterCodes(this.scope());
  }
}

/** The asset registry of a property (Spec §10.1, §10.3). */
@Controller('properties/:propertyId/eng')
@PropertyScoped({ from: 'param' })
export class AssetsController {
  constructor(
    private readonly assets: AssetService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('assets')
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string, @Query() query: ListAssetsDto) {
    return this.assets.listAssets(this.scope(propertyId), query);
  }

  @Post('assets')
  @RequirePermission('eng.asset.manage', { checkedBy: 'gate' })
  create(@Param('propertyId') propertyId: string, @Body() body: CreateAssetDto) {
    return this.assets.createAsset(this.scope(propertyId), body);
  }

  @Get('assets/:assetId')
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  get(@Param('propertyId') propertyId: string, @Param('assetId') assetId: string) {
    return this.assets.getAsset(this.scope(propertyId), assetId);
  }

  @Patch('assets/:assetId')
  @RequirePermission('eng.asset.manage', { checkedBy: 'gate' })
  update(
    @Param('propertyId') propertyId: string,
    @Param('assetId') assetId: string,
    @Body() body: UpdateAssetDto,
  ) {
    return this.assets.updateAsset(this.scope(propertyId), assetId, body);
  }

  @Post('asset-documents')
  @RequirePermission('eng.asset.manage', { checkedBy: 'gate' })
  linkDocument(@Param('propertyId') propertyId: string, @Body() body: LinkDocumentDto) {
    return this.assets.linkDocument(this.scope(propertyId), body);
  }
}

class CreateWorkOrderDto extends createZodDto(createWorkOrderSchema) {}
class FromRequestDto extends createZodDto(fromRequestSchema) {}
class UpdateWorkOrderDto extends createZodDto(updateWorkOrderSchema) {}
class CompleteWorkOrderDto extends createZodDto(completeWorkOrderSchema) {}
class ListWorkOrdersDto extends createZodDto(listWorkOrdersSchema) {}
class CreatePartDto extends createZodDto(createPartSchema) {}
class ReceivePartDto extends createZodDto(receivePartSchema) {}
class UsePartDto extends createZodDto(usePartSchema) {}
class WarrantyDecisionDto extends createZodDto(warrantyDecisionSchema) {}

/** Work orders, parts and warranty of a property (Spec §10.4, §10.8, §10.9). */
@Controller('properties/:propertyId/eng')
@PropertyScoped({ from: 'param' })
export class WorkOrdersController {
  constructor(
    private readonly orders: WorkOrderService,
    private readonly copilot: CopilotService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('work-orders')
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string, @Query() query: ListWorkOrdersDto) {
    return this.orders.list(this.scope(propertyId), query);
  }

  @Post('work-orders')
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  create(@Param('propertyId') propertyId: string, @Body() body: CreateWorkOrderDto) {
    return this.orders.create(this.scope(propertyId), body);
  }

  /** Engineering Copilot v1 (ASSIST): a question, optionally about the asset the engineer has open. */
  @Post('copilot')
  @HttpCode(200)
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  ask(@Param('propertyId') propertyId: string, @Body() body: AskCopilotDto) {
    return this.copilot.ask(this.scope(propertyId), body);
  }

  @Post('work-orders/from-request')
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  fromRequest(@Param('propertyId') propertyId: string, @Body() body: FromRequestDto) {
    return this.orders.fromRequest(this.scope(propertyId), body);
  }

  @Get('work-orders/:workOrderId')
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  get(@Param('propertyId') propertyId: string, @Param('workOrderId') id: string) {
    return this.orders.get(this.scope(propertyId), id);
  }

  @Patch('work-orders/:workOrderId')
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  update(
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') id: string,
    @Body() body: UpdateWorkOrderDto,
  ) {
    return this.orders.update(this.scope(propertyId), id, body);
  }

  @Post('work-orders/:workOrderId/complete')
  @HttpCode(200)
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  complete(
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') id: string,
    @Body() body: CompleteWorkOrderDto,
  ) {
    return this.orders.complete(this.scope(propertyId), id, body);
  }

  @Post('work-orders/:workOrderId/parts')
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  usePart(
    @Param('propertyId') propertyId: string,
    @Param('workOrderId') id: string,
    @Body() body: UsePartDto,
  ) {
    return this.orders.usePart(this.scope(propertyId), id, body);
  }

  @Get('parts')
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  parts(@Param('propertyId') propertyId: string) {
    return this.orders.listParts(this.scope(propertyId));
  }

  @Post('parts')
  @RequirePermission('eng.parts.manage', { checkedBy: 'gate' })
  createPart(@Param('propertyId') propertyId: string, @Body() body: CreatePartDto) {
    return this.orders.createPart(this.scope(propertyId), body);
  }

  @Post('parts/:partId/receipts')
  @RequirePermission('eng.parts.manage', { checkedBy: 'gate' })
  receive(
    @Param('propertyId') propertyId: string,
    @Param('partId') partId: string,
    @Body() body: ReceivePartDto,
  ) {
    return this.orders.receivePart(this.scope(propertyId), partId, body);
  }

  @Get('warranty-cases')
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  warranty(@Param('propertyId') propertyId: string) {
    return this.orders.warrantyCases(this.scope(propertyId));
  }

  @Post('warranty-cases/:caseId/decision')
  @HttpCode(200)
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  decide(
    @Param('propertyId') propertyId: string,
    @Param('caseId') id: string,
    @Body() body: WarrantyDecisionDto,
  ) {
    return this.orders.decideWarranty(this.scope(propertyId), id, body);
  }
}

class CreateMeterDto extends createZodDto(createMeterSchema) {}
class ReadingDto extends createZodDto(readingSchema) {}
class CreateProcedureDto extends createZodDto(createProcedureSchema) {}
class DraftVersionDto extends createZodDto(draftVersionSchema) {}
class CreatePlanDto extends createZodDto(createPlanSchema) {}
class UpdatePlanDto extends createZodDto(updatePlanSchema) {}
class CreateRestrictionDto extends createZodDto(createRestrictionSchema) {}
class ListRestrictionsDto extends createZodDto(listRestrictionsSchema) {}

/** Tenant-wide maintenance procedures, versioned (Spec §10.7). */
@Controller('eng/pm-procedures')
export class ProceduresController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope() {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.tenant.not_found');
    return { tenantId };
  }

  @Get()
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  list() {
    return this.maintenance.listProcedures(this.scope());
  }

  @Post()
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  create(@Body() body: CreateProcedureDto) {
    return this.maintenance.createProcedure(this.scope(), body);
  }

  @Post(':procedureId/versions')
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  draft(@Param('procedureId') id: string, @Body() body: DraftVersionDto) {
    return this.maintenance.newDraft(this.scope(), id, body);
  }

  @Post('versions/:versionId/publish')
  @HttpCode(200)
  @RequirePermission('eng.config.manage', { checkedBy: 'gate' })
  publish(@Param('versionId') id: string) {
    return this.maintenance.publish(this.scope(), id);
  }
}

/** Meters, preventive maintenance plans and room restrictions of a property (Spec §10.6, §10.7, §10.10). */
@Controller('properties/:propertyId/eng')
@PropertyScoped({ from: 'param' })
export class MaintenanceController {
  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly restrictions: RestrictionService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('meters')
  @RequirePermission('eng.asset.read', { checkedBy: 'gate' })
  meters(@Param('propertyId') propertyId: string, @Query('assetId') assetId?: string) {
    return this.maintenance.listMeters(this.scope(propertyId), assetId);
  }

  @Post('meters')
  @RequirePermission('eng.asset.manage', { checkedBy: 'gate' })
  createMeter(@Param('propertyId') propertyId: string, @Body() body: CreateMeterDto) {
    return this.maintenance.createMeter(this.scope(propertyId), body);
  }

  @Post('meters/:meterId/readings')
  @RequirePermission('eng.work_order.manage', { checkedBy: 'gate' })
  reading(
    @Param('propertyId') propertyId: string,
    @Param('meterId') meterId: string,
    @Body() body: ReadingDto,
  ) {
    return this.maintenance.recordReading(this.scope(propertyId), meterId, body);
  }

  @Get('pm-plans')
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  plans(@Param('propertyId') propertyId: string) {
    return this.maintenance.listPlans(this.scope(propertyId));
  }

  @Post('pm-plans')
  @RequirePermission('eng.pm.manage', { checkedBy: 'gate' })
  createPlan(@Param('propertyId') propertyId: string, @Body() body: CreatePlanDto) {
    return this.maintenance.createPlan(this.scope(propertyId), body);
  }

  @Patch('pm-plans/:planId')
  @RequirePermission('eng.pm.manage', { checkedBy: 'gate' })
  updatePlan(
    @Param('propertyId') propertyId: string,
    @Param('planId') planId: string,
    @Body() body: UpdatePlanDto,
  ) {
    return this.maintenance.updatePlan(this.scope(propertyId), planId, body);
  }

  @Get('room-restrictions')
  @RequirePermission('eng.work_order.read', { checkedBy: 'gate' })
  restrictionsList(@Param('propertyId') propertyId: string, @Query() query: ListRestrictionsDto) {
    return this.restrictions.list(this.scope(propertyId), query);
  }

  @Post('room-restrictions')
  @RequirePermission('eng.restriction.manage', { checkedBy: 'gate' })
  restrict(@Param('propertyId') propertyId: string, @Body() body: CreateRestrictionDto) {
    return this.restrictions.restrict(this.scope(propertyId), body);
  }

  @Post('room-restrictions/:restrictionId/release')
  @HttpCode(200)
  @RequirePermission('eng.restriction.manage', { checkedBy: 'gate' })
  release(@Param('propertyId') propertyId: string, @Param('restrictionId') id: string) {
    return this.restrictions.release(this.scope(propertyId), id);
  }
}

/** Building telemetry of a property (ADR-0024, BUILD_PLAN 13.2): points, rules, alarms and minute aggregates. */
@Controller('properties/:propertyId/eng/telemetry')
@PropertyScoped({ from: 'param' })
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('points')
  @RequirePermission('eng.telemetry.read', { checkedBy: 'gate' })
  points(@Param('propertyId') propertyId: string) {
    return this.telemetry.listPoints(this.scope(propertyId));
  }

  @Post('points')
  @RequirePermission('eng.telemetry.manage', { checkedBy: 'gate' })
  createPoint(@Param('propertyId') propertyId: string, @Body() body: CreatePointDto) {
    return this.telemetry.createPoint(this.scope(propertyId), body);
  }

  @Patch('points/:pointId')
  @RequirePermission('eng.telemetry.manage', { checkedBy: 'gate' })
  updatePoint(
    @Param('propertyId') propertyId: string,
    @Param('pointId') pointId: string,
    @Body() body: UpdatePointDto,
  ) {
    return this.telemetry.updatePoint(this.scope(propertyId), pointId, body);
  }

  @Get('points/:pointId/minutes')
  @RequirePermission('eng.telemetry.read', { checkedBy: 'gate' })
  minutes(
    @Param('propertyId') propertyId: string,
    @Param('pointId') pointId: string,
    @Query() query: MinutesQueryDto,
  ) {
    return this.telemetry.minutes(this.scope(propertyId), pointId, query);
  }

  @Get('rules')
  @RequirePermission('eng.telemetry.read', { checkedBy: 'gate' })
  rules(@Param('propertyId') propertyId: string, @Query('pointId') pointId?: string) {
    return this.telemetry.listRules(this.scope(propertyId), pointId);
  }

  @Post('rules')
  @RequirePermission('eng.telemetry.manage', { checkedBy: 'gate' })
  createRule(@Param('propertyId') propertyId: string, @Body() body: CreateRuleDto) {
    return this.telemetry.createRule(this.scope(propertyId), body);
  }

  @Post('rules/:ruleId/retire')
  @HttpCode(200)
  @RequirePermission('eng.telemetry.manage', { checkedBy: 'gate' })
  retire(
    @Param('propertyId') propertyId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: TelemetryVersionDto,
  ) {
    return this.telemetry.retireRule(this.scope(propertyId), ruleId, body.version);
  }

  @Get('alarms')
  @RequirePermission('eng.telemetry.read', { checkedBy: 'gate' })
  alarms(@Param('propertyId') propertyId: string, @Query() query: AlarmsQueryDto) {
    return this.telemetry.listAlarms(this.scope(propertyId), {
      live: query.live === 'true',
      pointId: query.pointId,
    });
  }

  @Post('alarms/:alarmId/acknowledge')
  @HttpCode(200)
  @RequirePermission('eng.telemetry.acknowledge', { checkedBy: 'gate' })
  acknowledge(
    @Param('propertyId') propertyId: string,
    @Param('alarmId') alarmId: string,
    @Body() body: TelemetryVersionDto,
  ) {
    return this.telemetry.acknowledge(this.scope(propertyId), alarmId, body.version);
  }
}
