import { Controller, Get, Param, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  GuestQueryService,
  listStaysQuerySchema,
  searchGuestsQuerySchema,
  StayQueryService,
} from '../application/queries';

class ListStaysQueryDto extends createZodDto(listStaysQuerySchema) {}
class SearchGuestsQueryDto extends createZodDto(searchGuestsQuerySchema) {}

function propertyScope(ctx: RequestContext, actors: ActorStore, propertyId: string): PropertyScope {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.property.not_found');
  return { tenantId, propertyId };
}

/**
 * Read-only by design (Spec §6, CLAUDE.md rule 19): guests and stays are created and changed only by canonical PMS
 * events. A unit test asserts this controller declares no mutating route.
 */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class StaysController {
  constructor(
    private readonly stays: StayQueryService,
    private readonly guests: GuestQueryService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get('stays')
  @RequirePermission('stay.read')
  list(@Param('propertyId') propertyId: string, @Query() query: ListStaysQueryDto) {
    return this.stays.list(propertyScope(this.ctx, this.actors, propertyId), query);
  }

  @Get('stays/:stayId')
  @RequirePermission('stay.read')
  get(@Param('propertyId') propertyId: string, @Param('stayId') stayId: string) {
    return this.stays.get(propertyScope(this.ctx, this.actors, propertyId), stayId);
  }

  @Get('rooms/:roomId/current-stay')
  @RequirePermission('stay.read')
  currentStay(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string) {
    return this.stays.currentStayForRoom(propertyScope(this.ctx, this.actors, propertyId), roomId);
  }

  @Get('guests')
  @RequirePermission('guest.read')
  searchGuests(@Param('propertyId') propertyId: string, @Query() query: SearchGuestsQueryDto) {
    return this.guests.search(propertyScope(this.ctx, this.actors, propertyId), query);
  }

  @Get('guests/:guestId')
  @RequirePermission('guest.read')
  guest(@Param('propertyId') propertyId: string, @Param('guestId') guestId: string) {
    return this.guests.get(propertyScope(this.ctx, this.actors, propertyId), guestId);
  }
}
