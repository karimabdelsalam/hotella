import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { uuidSchema } from '@hotella/contracts-api';
import {
  ActorStore,
  PropertyScoped,
  Public,
  RequirePermission,
  TenantScoped,
} from '@hotella/platform-auth';
import { CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  createLocationSchema,
  createOrganizationSchema,
  createPropertySchema,
  createRoomSchema,
  createRoomTypeSchema,
  createTenantSchema,
  publicBrandingQuerySchema,
  updatePropertySchema,
  upsertBrandProfileSchema,
} from '../application/dto';
import {
  BrandingService,
  LocationService,
  OrganizationService,
  PropertyService,
  resolveTenantId,
  RoomService,
  TenantService,
} from '../application/services';

class CreateTenantDto extends createZodDto(createTenantSchema) {}
class CreateOrganizationDto extends createZodDto(createOrganizationSchema) {}
class CreatePropertyDto extends createZodDto(createPropertySchema) {}
class UpdatePropertyDto extends createZodDto(updatePropertySchema) {}
class CreateLocationDto extends createZodDto(createLocationSchema) {}
class CreateRoomTypeDto extends createZodDto(createRoomTypeSchema) {}
class CreateRoomDto extends createZodDto(createRoomSchema) {}
class UpsertBrandProfileDto extends createZodDto(upsertBrandProfileSchema) {}
class PublicBrandingQueryDto extends createZodDto(publicBrandingQuerySchema) {}
class TenantQueryDto extends createZodDto(z.object({ tenantId: uuidSchema.optional() })) {}
class TreeQueryDto extends createZodDto(z.object({ lang: z.string().optional() })) {}

@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantService,
    private readonly organizations: OrganizationService,
  ) {}

  @Post()
  @RequirePermission('org.tenant.manage')
  create(@Body() body: CreateTenantDto) {
    return this.tenants.create(body);
  }
  @Get()
  @RequirePermission('org.tenant.manage')
  list() {
    return this.tenants.list();
  }
  @Get(':tenantId')
  @TenantScoped({ from: 'param' })
  @RequirePermission('org.tenant.manage')
  get(@Param('tenantId') tenantId: string) {
    return this.tenants.get(tenantId);
  }
  @Post(':tenantId/organizations')
  @TenantScoped({ from: 'param' })
  @RequirePermission('org.tenant.manage')
  createOrganization(@Param('tenantId') tenantId: string, @Body() body: CreateOrganizationDto) {
    return this.organizations.create({ tenantId }, body);
  }
  @Get(':tenantId/organizations')
  @TenantScoped({ from: 'param' })
  @RequirePermission('org.tenant.manage')
  listOrganizations(@Param('tenantId') tenantId: string) {
    return this.organizations.list({ tenantId });
  }
}

@Controller('properties')
export class PropertiesController {
  constructor(
    private readonly properties: PropertyService,
    private readonly locations: LocationService,
    private readonly rooms: RoomService,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
    /** Tenant derived by the guard from the property (platform staff act on a property without naming its tenant). */
    private readonly ctx: RequestContext,
  ) {}

  @Post()
  @RequirePermission('org.property.manage')
  create(@Body() body: CreatePropertyDto) {
    return this.properties.create(
      { tenantId: resolveTenantId(this.actors.require(), body.tenantId) },
      body,
    );
  }
  @Get()
  @RequirePermission('org.property.read')
  list(@Query() query: TenantQueryDto) {
    return this.properties.list({
      tenantId: resolveTenantId(this.actors.require(), query.tenantId),
    });
  }
  @Get(':propertyId')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.property.read')
  get(@Param('propertyId') propertyId: string, @Query() query: TenantQueryDto) {
    return this.properties.get(
      { tenantId: resolveTenantId(this.actors.require(), query.tenantId ?? this.ctx.tenantId) },
      propertyId,
    );
  }
  @Patch(':propertyId')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.property.manage')
  update(
    @Param('propertyId') propertyId: string,
    @Query() query: TenantQueryDto,
    @Body() body: UpdatePropertyDto,
  ) {
    return this.properties.update(
      { tenantId: resolveTenantId(this.actors.require(), query.tenantId ?? this.ctx.tenantId) },
      propertyId,
      body,
    );
  }

  @Get(':propertyId/locations')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.property.read')
  async tree(
    @Param('propertyId') propertyId: string,
    @Query() query: TenantQueryDto & TreeQueryDto,
  ) {
    const scope = await this.scope(propertyId, query.tenantId);
    return this.locations.tree(scope.scope, scope.property, query.lang ?? this.locale.get());
  }
  @Post(':propertyId/locations')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.location.manage')
  async createLocation(
    @Param('propertyId') propertyId: string,
    @Query() query: TenantQueryDto,
    @Body() body: CreateLocationDto,
  ) {
    const { scope } = await this.scope(propertyId, query.tenantId);
    return this.locations.create(scope, body);
  }
  @Get(':propertyId/room-types')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.property.read')
  async listRoomTypes(@Param('propertyId') propertyId: string, @Query() query: TenantQueryDto) {
    const { scope } = await this.scope(propertyId, query.tenantId);
    return this.rooms.listRoomTypes(scope);
  }
  @Post(':propertyId/room-types')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.location.manage')
  async createRoomType(
    @Param('propertyId') propertyId: string,
    @Query() query: TenantQueryDto,
    @Body() body: CreateRoomTypeDto,
  ) {
    const { scope } = await this.scope(propertyId, query.tenantId);
    return this.rooms.createRoomType(scope, body);
  }
  @Get(':propertyId/rooms')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.property.read')
  async listRooms(@Param('propertyId') propertyId: string, @Query() query: TenantQueryDto) {
    const { scope } = await this.scope(propertyId, query.tenantId);
    return this.rooms.list(scope);
  }
  @Post(':propertyId/rooms')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('org.location.manage')
  async createRoom(
    @Param('propertyId') propertyId: string,
    @Query() query: TenantQueryDto,
    @Body() body: CreateRoomDto,
  ) {
    const { scope, property } = await this.scope(propertyId, query.tenantId);
    return this.rooms.create(scope, property, body);
  }

  /** Confirms the property belongs to the acting tenant (404 otherwise) and returns the scope. */
  private async scope(propertyId: string, named?: string) {
    const tenantId = resolveTenantId(this.actors.require(), named ?? this.ctx.tenantId);
    const property = await this.properties.get({ tenantId }, propertyId);
    return { scope: { tenantId, propertyId }, property };
  }
}

@Controller()
export class BrandingController {
  constructor(
    private readonly branding: BrandingService,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  @Put('branding/profiles')
  @RequirePermission('branding.manage')
  upsert(@Query() query: TenantQueryDto, @Body() body: UpsertBrandProfileDto) {
    return this.branding.upsert(
      { tenantId: resolveTenantId(this.actors.require(), query.tenantId) },
      body,
    );
  }
  @Get('branding/profiles')
  @RequirePermission('branding.read')
  list(@Query() query: TenantQueryDto) {
    return this.branding.list({ tenantId: resolveTenantId(this.actors.require(), query.tenantId) });
  }
  /** Guest-facing: QR pages, guest web and the WhatsApp context call this before anything else. */
  @Public()
  @Get('public/branding')
  resolve(@Query() query: PublicBrandingQueryDto) {
    return this.branding.resolve(
      query.property,
      query.channel ?? null,
      query.lang ?? this.locale.requested(),
    );
  }
}
