import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import {
  CurrentGuest,
  type GuestPrincipal,
  GuestSessionGuard,
  RequireGuestScope,
} from '@hotella/domain-guest/public';
import { ActorStore, Public, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { CatalogAdminService } from '../application/admin.service';
import { CatalogReader } from '../application/catalog-reader';
import {
  catalogQuerySchema,
  createCategorySchema,
  createServiceSchema,
  publishSchema,
  updateCategorySchema,
  updateDraftSchema,
  updateServiceSchema,
} from '../application/schemas';
import { StarterCatalogService, starterImportSchema } from '../application/starter';

class CatalogQueryDto extends createZodDto(catalogQuerySchema) {}
class CreateCategoryDto extends createZodDto(createCategorySchema) {}
class UpdateCategoryDto extends createZodDto(updateCategorySchema) {}
class CreateServiceDto extends createZodDto(createServiceSchema) {}
class UpdateServiceDto extends createZodDto(updateServiceSchema) {}
class UpdateDraftDto extends createZodDto(updateDraftSchema) {}
class PublishDto extends createZodDto(publishSchema) {}
class StarterImportDto extends createZodDto(starterImportSchema) {}

function tenantScope(ctx: RequestContext, actors: ActorStore): TenantScope {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.tenant.not_found');
  return { tenantId };
}

/**
 * Catalog administration (Spec §7): tenant-wide items (no `propertyId`, tenant-wide membership) or a property's. The
 * level is only known once the item is loaded, so the service's ActionGate checks the declared permission there.
 */
@Controller('catalog')
export class CatalogAdminController {
  constructor(
    private readonly admin: CatalogAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope() {
    return tenantScope(this.ctx, this.actors);
  }

  @Get('categories')
  @RequirePermission('catalog.read', { checkedBy: 'gate' })
  categories(@Query() query: CatalogQueryDto) {
    return this.admin.listCategories(this.scope(), query.propertyId ?? null);
  }

  @Post('categories')
  @RequirePermission('catalog.manage', { checkedBy: 'gate' })
  createCategory(@Body() body: CreateCategoryDto) {
    return this.admin.createCategory(this.scope(), body);
  }

  @Patch('categories/:id')
  @RequirePermission('catalog.manage', { checkedBy: 'gate' })
  updateCategory(@Param('id') id: string, @Body() body: UpdateCategoryDto) {
    return this.admin.updateCategory(this.scope(), id, body);
  }

  @Get('services')
  @RequirePermission('catalog.read', { checkedBy: 'gate' })
  services(@Query() query: CatalogQueryDto) {
    return this.admin.listServices(this.scope(), query.propertyId ?? null);
  }

  @Get('services/:id')
  @RequirePermission('catalog.read', { checkedBy: 'gate' })
  service(@Param('id') id: string) {
    return this.admin.getService(this.scope(), id);
  }

  @Post('services')
  @RequirePermission('catalog.manage', { checkedBy: 'gate' })
  createService(@Body() body: CreateServiceDto) {
    return this.admin.createService(this.scope(), body);
  }

  @Patch('services/:id')
  @RequirePermission('catalog.manage', { checkedBy: 'gate' })
  updateService(@Param('id') id: string, @Body() body: UpdateServiceDto) {
    return this.admin.updateService(this.scope(), id, body);
  }

  @Post('services/:id/drafts')
  @RequirePermission('catalog.manage', { checkedBy: 'gate' })
  createDraft(@Param('id') id: string) {
    return this.admin.createDraft(this.scope(), id);
  }

  @Patch('versions/:id')
  @RequirePermission('catalog.manage', { checkedBy: 'gate' })
  updateDraft(@Param('id') id: string, @Body() body: UpdateDraftDto) {
    return this.admin.updateDraft(this.scope(), id, body);
  }

  @Post('versions/:id/publish')
  @HttpCode(200)
  @RequirePermission('catalog.publish', { checkedBy: 'gate' })
  publish(@Param('id') id: string, @Body() body: PublishDto) {
    return this.admin.publish(this.scope(), id, body.version);
  }
}

/** The starter catalog of a property (Spec §7 examples, texts from the locale catalog). */
@Controller('properties/:propertyId/catalog')
@PropertyScoped({ from: 'param' })
export class PropertyCatalogController {
  constructor(
    private readonly starter: StarterCatalogService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Post('starter')
  @HttpCode(200)
  @RequirePermission('catalog.manage')
  importStarter(@Param('propertyId') propertyId: string, @Body() body: StarterImportDto) {
    return this.starter.import({ ...tenantScope(this.ctx, this.actors), propertyId }, body);
  }
}

/** The guest catalog (Spec §7, §21): what this guest may request here, in their language. */
@Controller('guest/services')
@Public()
@UseGuards(GuestSessionGuard)
@RequireGuestScope('SERVICE_REQUEST')
export class GuestCatalogController {
  constructor(
    private readonly reader: CatalogReader,
    private readonly locale: CurrentLocale,
    private readonly tx: TransactionRunner,
  ) {}

  @Get()
  list(@CurrentGuest() guest: GuestPrincipal) {
    return this.tx.read(() => this.reader.guestCatalog(guest, this.locale.get()));
  }

  @Get(':code')
  get(@CurrentGuest() guest: GuestPrincipal, @Param('code') code: string) {
    return this.tx.read(() => this.reader.guestService(guest, code, this.locale.get()));
  }
}
