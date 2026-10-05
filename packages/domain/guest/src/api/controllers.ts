import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { GuestAccessAdminService, revokeGrantSchema } from '../application/access.service';
import { issueRoomAccessSchema, RoomAccessService } from '../application/room-access.service';
import {
  dataRequestSchema,
  GuestDataService,
  mergeGuestSchema,
  recordConsentSchema,
  upsertPreferenceSchema,
} from '../application/guest-data.service';
import {
  GuestQueryService,
  listStaysQuerySchema,
  searchGuestsQuerySchema,
  StayQueryService,
} from '../application/queries';

class ListStaysQueryDto extends createZodDto(listStaysQuerySchema) {}
class SearchGuestsQueryDto extends createZodDto(searchGuestsQuerySchema) {}
class UpsertPreferenceDto extends createZodDto(upsertPreferenceSchema) {}
class RecordConsentDto extends createZodDto(recordConsentSchema) {}
class MergeGuestDto extends createZodDto(mergeGuestSchema) {}
class DataRequestDto extends createZodDto(dataRequestSchema) {}

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

/**
 * What staff maintain about a guest who stays at the property: preferences, consents, merges of duplicates and
 * data-subject requests. Nothing here creates a guest or changes a stay (CLAUDE.md rule 19).
 */
@Controller('properties/:propertyId/guests/:guestId')
@PropertyScoped({ from: 'param' })
export class GuestProfilesController {
  constructor(
    private readonly data: GuestDataService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get('preferences')
  @RequirePermission('guest.read')
  preferences(@Param('propertyId') propertyId: string, @Param('guestId') guestId: string) {
    return this.data.preferences(propertyScope(this.ctx, this.actors, propertyId), guestId);
  }

  @Put('preferences')
  @RequirePermission('guest.manage')
  upsertPreference(
    @Param('propertyId') propertyId: string,
    @Param('guestId') guestId: string,
    @Body() body: UpsertPreferenceDto,
  ) {
    return this.data.upsertPreference(
      propertyScope(this.ctx, this.actors, propertyId),
      guestId,
      body,
    );
  }

  @Delete('preferences/:preferenceId')
  @RequirePermission('guest.manage')
  deletePreference(
    @Param('propertyId') propertyId: string,
    @Param('guestId') guestId: string,
    @Param('preferenceId') preferenceId: string,
  ) {
    return this.data.deletePreference(
      propertyScope(this.ctx, this.actors, propertyId),
      guestId,
      preferenceId,
    );
  }

  @Get('consents')
  @RequirePermission('guest.read')
  consents(@Param('propertyId') propertyId: string, @Param('guestId') guestId: string) {
    return this.data.consents(propertyScope(this.ctx, this.actors, propertyId), guestId);
  }

  @Post('consents')
  @RequirePermission('guest.manage')
  recordConsent(
    @Param('propertyId') propertyId: string,
    @Param('guestId') guestId: string,
    @Body() body: RecordConsentDto,
  ) {
    return this.data.recordConsent(propertyScope(this.ctx, this.actors, propertyId), guestId, body);
  }

  @Post('merge')
  @HttpCode(200)
  @RequirePermission('guest.merge')
  merge(
    @Param('propertyId') propertyId: string,
    @Param('guestId') guestId: string,
    @Body() body: MergeGuestDto,
  ) {
    return this.data.merge(propertyScope(this.ctx, this.actors, propertyId), guestId, body);
  }

  @Get('data-requests')
  @RequirePermission('guest.data_request.manage')
  dataRequests(@Param('propertyId') propertyId: string, @Param('guestId') guestId: string) {
    return this.data.dataRequests(propertyScope(this.ctx, this.actors, propertyId), guestId);
  }

  @Post('data-requests')
  @RequirePermission('guest.data_request.manage')
  dataRequest(
    @Param('propertyId') propertyId: string,
    @Param('guestId') guestId: string,
    @Body() body: DataRequestDto,
  ) {
    return this.data.dataRequest(propertyScope(this.ctx, this.actors, propertyId), guestId, body);
  }
}

class RevokeGrantDto extends createZodDto(revokeGrantSchema) {}

/** Staff view of guest access (Spec §21): grants of a stay with their history, and revocation with a reason. */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class GuestAccessController {
  constructor(
    private readonly access: GuestAccessAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get('stays/:stayId/grants')
  @RequirePermission('stay.read')
  list(@Param('propertyId') propertyId: string, @Param('stayId') stayId: string) {
    return this.access.listForStay(propertyScope(this.ctx, this.actors, propertyId), stayId);
  }

  @Post('guest-grants/:grantId/revoke')
  @HttpCode(200)
  @RequirePermission('guest.grant.revoke')
  revoke(
    @Param('propertyId') propertyId: string,
    @Param('grantId') grantId: string,
    @Body() body: RevokeGrantDto,
  ) {
    const actor = this.actors.require();
    return this.access.revokeByStaff(
      propertyScope(this.ctx, this.actors, propertyId),
      grantId,
      body,
      {
        type: actor.type,
        id: actor.id,
      },
    );
  }
}

class IssueRoomAccessDto extends createZodDto(issueRoomAccessSchema) {}

/**
 * Room keys and Wi-Fi of an in-house stay (BUILD_PLAN 13.3, rule 19), served by the property's lock and Wi-Fi
 * connectors. The gate checks the kind's permission (`access.key.issue` or `access.wifi.issue`).
 */
@Controller('properties/:propertyId/stays/:stayId/access')
@PropertyScoped({ from: 'param' })
export class RoomAccessController {
  constructor(
    private readonly access: RoomAccessService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('access.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string, @Param('stayId') stayId: string) {
    return this.access.list(propertyScope(this.ctx, this.actors, propertyId), stayId);
  }

  @Post()
  @RequirePermission('access.key.issue', { checkedBy: 'gate' })
  issue(
    @Param('propertyId') propertyId: string,
    @Param('stayId') stayId: string,
    @Body() body: IssueRoomAccessDto,
  ) {
    return this.access.issue(propertyScope(this.ctx, this.actors, propertyId), stayId, body.kind);
  }

  @Post(':grantId/revoke')
  @HttpCode(200)
  @RequirePermission('access.key.issue', { checkedBy: 'gate' })
  revoke(
    @Param('propertyId') propertyId: string,
    @Param('stayId') stayId: string,
    @Param('grantId') grantId: string,
  ) {
    return this.access.revoke(propertyScope(this.ctx, this.actors, propertyId), stayId, grantId);
  }
}
