import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CurrentGuest,
  GUEST_API,
  type GuestPrincipal,
  type GuestPublicApi,
  GuestSessionGuard,
  RequireGuestScope,
} from '@hotella/domain-guest/public';
import { ActorStore, PropertyScoped, Public, RequirePermission } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { RoomStateService, setStateSchema, signalSchema } from '../application/room-state.service';

class SetStateDto extends createZodDto(setStateSchema) {}
class SignalDto extends createZodDto(signalSchema) {}
const guestSignalSchema = z.object({
  signal: z.enum(['DND', 'MAKE_UP_ROOM']),
  active: z.boolean(),
});
class GuestSignalDto extends createZodDto(guestSignalSchema) {}

/** The housekeeping board of a property (Spec §9): rooms, states, signals, history. */
@Controller('properties/:propertyId/housekeeping')
@PropertyScoped({ from: 'param' })
export class HousekeepingController {
  constructor(
    private readonly rooms: RoomStateService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }
  private actor() {
    const a = this.actors.require();
    return { type: a.type, id: a.id };
  }

  @Get('rooms')
  @RequirePermission('hk.board.read')
  board(@Param('propertyId') propertyId: string) {
    return this.rooms.board(this.scope(propertyId));
  }

  @Get('rooms/:roomId/history')
  @RequirePermission('hk.board.read')
  history(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string) {
    return this.rooms.history(this.scope(propertyId), roomId);
  }

  @Post('rooms/:roomId/state')
  @HttpCode(200)
  @RequirePermission('hk.room.manage')
  setState(
    @Param('propertyId') propertyId: string,
    @Param('roomId') roomId: string,
    @Body() body: SetStateDto,
  ) {
    return this.rooms.setByStaff(this.scope(propertyId), roomId, body, this.actor());
  }

  @Post('rooms/:roomId/signals')
  @HttpCode(200)
  @RequirePermission('hk.room.manage')
  signal(
    @Param('propertyId') propertyId: string,
    @Param('roomId') roomId: string,
    @Body() body: SignalDto,
  ) {
    return this.rooms.signalByStaff(this.scope(propertyId), roomId, body, this.actor());
  }
}

/** The guest's own room: do not disturb, or please make up the room (Spec §9.3, guest portal source). */
@Controller('guest/room-signals')
@Public()
@UseGuards(GuestSessionGuard)
@RequireGuestScope('SERVICE_REQUEST')
export class GuestRoomSignalsController {
  constructor(
    private readonly rooms: RoomStateService,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
  ) {}

  @Post()
  @HttpCode(200)
  async set(@CurrentGuest() guest: GuestPrincipal, @Body() body: GuestSignalDto) {
    const stay = guest.stayId ? await this.guests.getStay(guest.tenantId, guest.stayId) : null;
    if (!stay || stay.status !== 'IN_HOUSE' || !stay.currentRoomId)
      throw AppError.conflict('hk.signal.no_room');
    return this.rooms.signal(
      { tenantId: guest.tenantId, propertyId: stay.propertyId },
      stay.currentRoomId,
      body,
      'GUEST_PORTAL',
      { type: 'GUEST', id: guest.guestId },
    );
  }
}
