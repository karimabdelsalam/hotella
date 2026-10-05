import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
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
import { ActorStore, PropertyScoped, Public, RequirePermission } from '@hotella/platform-auth';
import { RateLimit } from '@hotella/platform-http';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { ReservationService } from '../application/reservation.service';
import { RestaurantService } from '../application/restaurant.service';
import {
  boardQuerySchema,
  closureSchema,
  createRestaurantSchema,
  guestBookSchema,
  rangeSchema,
  scheduleSchema,
  staffBookSchema,
  stayLookupSchema,
  transitionSchema,
  translationSchema,
  updateRestaurantSchema,
} from '../application/schemas';

class CreateRestaurantDto extends createZodDto(createRestaurantSchema) {}
class UpdateRestaurantDto extends createZodDto(updateRestaurantSchema) {}
class RestaurantTranslationDto extends createZodDto(translationSchema) {}
class ScheduleDto extends createZodDto(scheduleSchema) {}
class ClosureDto extends createZodDto(closureSchema) {}
class RangeDto extends createZodDto(rangeSchema) {}
class StaffBookDto extends createZodDto(staffBookSchema) {}
class GuestBookDto extends createZodDto(guestBookSchema) {}
class TransitionDto extends createZodDto(transitionSchema) {}
class ReservationBoardQueryDto extends createZodDto(boardQuerySchema) {}
class RestaurantStayLookupDto extends createZodDto(stayLookupSchema) {}

abstract class PropertyController {
  constructor(
    protected readonly ctx: RequestContext,
    protected readonly actors: ActorStore,
    protected readonly locale: CurrentLocale,
  ) {}
  protected scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.tenant.not_found');
    return { tenantId, propertyId };
  }
}

/** A property's à la carte restaurants: names, rules, weekly sittings, closures, availability. */
@Controller('properties/:propertyId/restaurants')
@PropertyScoped({ from: 'param' })
export class RestaurantsController extends PropertyController {
  constructor(
    private readonly restaurants: RestaurantService,
    ctx: RequestContext,
    actors: ActorStore,
    locale: CurrentLocale,
  ) {
    super(ctx, actors, locale);
  }

  @Get()
  @RequirePermission('restaurant.restaurant.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string) {
    return this.restaurants.list(this.scope(propertyId), this.locale.get());
  }

  @Post()
  @RequirePermission('restaurant.restaurant.manage', { checkedBy: 'gate' })
  create(@Param('propertyId') propertyId: string, @Body() body: CreateRestaurantDto) {
    return this.restaurants.create(this.scope(propertyId), body, this.locale.get());
  }

  @Get('availability')
  @RequirePermission('restaurant.restaurant.read', { checkedBy: 'gate' })
  availability(@Param('propertyId') propertyId: string, @Query() q: RangeDto) {
    return this.restaurants.availability(this.scope(propertyId), q.from, q.to, this.locale.get());
  }

  @Get(':restaurantId')
  @RequirePermission('restaurant.restaurant.read', { checkedBy: 'gate' })
  get(@Param('propertyId') propertyId: string, @Param('restaurantId') id: string) {
    return this.restaurants.get(this.scope(propertyId), id, this.locale.get());
  }

  @Patch(':restaurantId')
  @RequirePermission('restaurant.restaurant.manage', { checkedBy: 'gate' })
  update(
    @Param('propertyId') propertyId: string,
    @Param('restaurantId') id: string,
    @Body() body: UpdateRestaurantDto,
  ) {
    return this.restaurants.update(this.scope(propertyId), id, body, this.locale.get());
  }

  @Put(':restaurantId/translations/:locale')
  @RequirePermission('restaurant.restaurant.manage', { checkedBy: 'gate' })
  translate(
    @Param('propertyId') propertyId: string,
    @Param('restaurantId') id: string,
    @Param('locale') locale: string,
    @Body() body: RestaurantTranslationDto,
  ) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale))
      throw AppError.notFound('restaurant.locale_invalid');
    return this.restaurants.setTranslation(this.scope(propertyId), id, locale, body);
  }

  @Put(':restaurantId/sittings')
  @RequirePermission('restaurant.restaurant.manage', { checkedBy: 'gate' })
  schedule(
    @Param('propertyId') propertyId: string,
    @Param('restaurantId') id: string,
    @Body() body: ScheduleDto,
  ) {
    return this.restaurants.setSchedule(this.scope(propertyId), id, body);
  }

  @Post(':restaurantId/closures')
  @RequirePermission('restaurant.restaurant.manage', { checkedBy: 'gate' })
  close(
    @Param('propertyId') propertyId: string,
    @Param('restaurantId') id: string,
    @Body() body: ClosureDto,
  ) {
    return this.restaurants.addClosure(this.scope(propertyId), id, body);
  }

  @Delete(':restaurantId/closures/:closureId')
  @RequirePermission('restaurant.restaurant.manage', { checkedBy: 'gate' })
  reopen(
    @Param('propertyId') propertyId: string,
    @Param('restaurantId') id: string,
    @Param('closureId') closureId: string,
  ) {
    return this.restaurants.removeClosure(this.scope(propertyId), id, closureId);
  }
}

/** The reservations board and bookings on a guest's behalf (restaurant team, guest relations, phone bookings). */
@Controller('properties/:propertyId/restaurant-reservations')
@PropertyScoped({ from: 'param' })
export class ReservationsController extends PropertyController {
  constructor(
    private readonly reservations: ReservationService,
    ctx: RequestContext,
    actors: ActorStore,
    locale: CurrentLocale,
  ) {
    super(ctx, actors, locale);
  }

  @Get()
  @RequirePermission('restaurant.reservation.read', { checkedBy: 'gate' })
  board(@Param('propertyId') propertyId: string, @Query() q: ReservationBoardQueryDto) {
    return this.reservations.board(
      this.scope(propertyId),
      q.date,
      q.restaurantId,
      this.locale.get(),
    );
  }

  /** Who is in a room (for a phone booking), with each restaurant's bookings left. */
  @Get('stays')
  @RequirePermission('restaurant.reservation.manage', { checkedBy: 'gate' })
  stays(@Param('propertyId') propertyId: string, @Query() q: RestaurantStayLookupDto) {
    return this.reservations.findStays(this.scope(propertyId), q.room, this.locale.get());
  }

  @Get(':reservationId')
  @RequirePermission('restaurant.reservation.read', { checkedBy: 'gate' })
  detail(@Param('propertyId') propertyId: string, @Param('reservationId') id: string) {
    return this.reservations.detail(this.scope(propertyId), id, this.locale.get());
  }

  @Post()
  @RequirePermission('restaurant.reservation.manage', { checkedBy: 'gate' })
  book(@Param('propertyId') propertyId: string, @Body() body: StaffBookDto) {
    return this.reservations.bookForGuest(this.scope(propertyId), body);
  }

  @Post(':reservationId/seat')
  @HttpCode(200)
  @RequirePermission('restaurant.reservation.manage', { checkedBy: 'gate' })
  seat(
    @Param('propertyId') p: string,
    @Param('reservationId') id: string,
    @Body() body: TransitionDto,
  ) {
    return this.reservations.transition(this.scope(p), id, 'SEATED', body);
  }

  @Post(':reservationId/complete')
  @HttpCode(200)
  @RequirePermission('restaurant.reservation.manage', { checkedBy: 'gate' })
  complete(
    @Param('propertyId') p: string,
    @Param('reservationId') id: string,
    @Body() body: TransitionDto,
  ) {
    return this.reservations.transition(this.scope(p), id, 'COMPLETED', body);
  }

  @Post(':reservationId/no-show')
  @HttpCode(200)
  @RequirePermission('restaurant.reservation.manage', { checkedBy: 'gate' })
  noShow(
    @Param('propertyId') p: string,
    @Param('reservationId') id: string,
    @Body() body: TransitionDto,
  ) {
    return this.reservations.transition(this.scope(p), id, 'NO_SHOW', body);
  }

  @Post(':reservationId/cancel')
  @HttpCode(200)
  @RequirePermission('restaurant.reservation.manage', { checkedBy: 'gate' })
  cancel(
    @Param('propertyId') p: string,
    @Param('reservationId') id: string,
    @Body() body: TransitionDto,
  ) {
    return this.reservations.transition(this.scope(p), id, 'CANCELLED', body);
  }
}

/** A guest's à la carte bookings (guest scope DINING): what is open, book, list, cancel before the cut-off. */
@Controller('guest')
@Public()
@UseGuards(GuestSessionGuard)
@RequireGuestScope('DINING')
export class GuestRestaurantController {
  constructor(
    private readonly reservations: ReservationService,
    private readonly locale: CurrentLocale,
  ) {}

  @Get('restaurants')
  offer(@CurrentGuest() guest: GuestPrincipal) {
    return this.reservations.guestOffer(guest, this.locale.get());
  }

  @Get('restaurant-reservations')
  list(@CurrentGuest() guest: GuestPrincipal) {
    return this.reservations.guestReservations(guest, this.locale.get());
  }

  @Post('restaurant-reservations')
  @RateLimit({ name: 'guest-restaurant-booking', limit: 20, windowSeconds: 600, keyBy: 'ip' })
  book(@CurrentGuest() guest: GuestPrincipal, @Body() body: GuestBookDto) {
    return this.reservations.guestBook(guest, body);
  }

  @Post('restaurant-reservations/:reservationId/cancel')
  @HttpCode(200)
  cancel(@CurrentGuest() guest: GuestPrincipal, @Param('reservationId') id: string) {
    return this.reservations.guestCancel(guest, id);
  }
}
