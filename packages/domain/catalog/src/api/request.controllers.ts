import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import {
  CurrentGuest,
  type GuestPrincipal,
  GuestSessionGuard,
  RequireGuestScope,
} from '@hotella/domain-guest/public';
import { ActorStore, PropertyScoped, Public, RequirePermission } from '@hotella/platform-auth';
import { RateLimit } from '@hotella/platform-http';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  boardQuerySchema,
  cancelSchema,
  guestRequestSchema,
  ServiceRequestService,
  staffRequestSchema,
} from '../application/request.service';

class GuestRequestDto extends createZodDto(guestRequestSchema) {}
class StaffRequestDto extends createZodDto(staffRequestSchema) {}
class CancelDto extends createZodDto(cancelSchema) {}
class BoardQueryDto extends createZodDto(boardQuerySchema) {}

/** A guest's service requests (Spec §7, §21): ask, follow, cancel while nobody started. */
@Controller('guest/requests')
@Public()
@UseGuards(GuestSessionGuard)
@RequireGuestScope('SERVICE_REQUEST')
export class GuestRequestsController {
  constructor(
    private readonly requests: ServiceRequestService,
    private readonly locale: CurrentLocale,
  ) {}

  @Post()
  @RateLimit({ name: 'guest-service-request', limit: 30, windowSeconds: 600, keyBy: 'ip' })
  async create(@CurrentGuest() guest: GuestPrincipal, @Body() body: GuestRequestDto) {
    if (!guest.stayId) throw AppError.forbidden('catalog.request.stay_required');
    return this.requests.create(
      {
        tenantId: guest.tenantId,
        propertyId: guest.propertyId,
        stayId: guest.stayId,
        guestId: guest.guestId,
        serviceCode: body.serviceCode,
        fields: body.fields,
        requestedForAt: body.requestedForAt ?? null,
        locale: this.locale.get(),
        source: 'GUEST_WEB',
      },
      guest,
    );
  }

  @Get()
  list(@CurrentGuest() guest: GuestPrincipal) {
    return this.requests.guestRequests(guest, this.locale.get());
  }

  @Get(':id')
  get(@CurrentGuest() guest: GuestPrincipal, @Param('id') id: string) {
    return this.requests.guestRequest(guest, id, this.locale.get());
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentGuest() guest: GuestPrincipal, @Param('id') id: string) {
    return this.requests.cancelByGuest(guest, id);
  }
}

/** The requests board of a property and requests on a guest's behalf (front desk). */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class StaffRequestsController {
  constructor(
    private readonly requests: ServiceRequestService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('service-requests')
  @RequirePermission('request.read')
  board(@Param('propertyId') propertyId: string, @Query() query: BoardQueryDto) {
    return this.requests.board(this.scope(propertyId), query, this.locale.get());
  }

  @Get('service-requests/:id')
  @RequirePermission('request.read')
  detail(@Param('propertyId') propertyId: string, @Param('id') id: string) {
    return this.requests.detail(this.scope(propertyId), id, this.locale.get());
  }

  @Post('stays/:stayId/service-requests')
  @RequirePermission('request.create')
  create(
    @Param('propertyId') propertyId: string,
    @Param('stayId') stayId: string,
    @Body() body: StaffRequestDto,
  ) {
    return this.requests.createForGuest(this.scope(propertyId), stayId, body, this.locale.get());
  }

  @Post('service-requests/:id/cancel')
  @HttpCode(200)
  @RequirePermission('request.manage')
  cancel(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Body() body: CancelDto,
  ) {
    return this.requests.cancelByStaff(this.scope(propertyId), id, body.reason ?? null);
  }
}
