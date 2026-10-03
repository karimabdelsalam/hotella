import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
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
