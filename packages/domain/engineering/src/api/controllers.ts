import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
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
