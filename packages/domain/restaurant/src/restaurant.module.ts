import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import {
  GuestRestaurantController,
  ReservationsController,
  RestaurantsController,
} from './api/controllers';
import { ReservationService } from './application/reservation.service';
import { RestaurantService } from './application/restaurant.service';
import { RESTAURANT_SETTINGS } from './domain/settings';
import { RestaurantRepositories } from './infrastructure/repositories';
import { RESTAURANT_MANIFEST } from './manifest';

export const RESTAURANT_STAY_CONSUMER = 'restaurant.stay-ended';

/** Restaurant without HTTP routes (API and worker). */
@Global()
@Module({
  providers: [RestaurantRepositories, RestaurantService, ReservationService],
  exports: [RestaurantRepositories, RestaurantService, ReservationService],
})
export class RestaurantCoreModule {}

/** Staff and guest API, settings and manifest, for the API process. */
@Module({
  imports: [RestaurantCoreModule],
  controllers: [RestaurantsController, ReservationsController, GuestRestaurantController],
})
export class RestaurantModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(RESTAURANT_MANIFEST);
    this.settings.register(...RESTAURANT_SETTINGS);
  }
}

/** Worker side: a stay that leaves the house (PMS) has its confirmed reservations ahead cancelled. */
@Module({ imports: [RestaurantCoreModule] })
export class RestaurantWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly reservations: ReservationService,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.settings.register(...RESTAURANT_SETTINGS);
    for (const def of ReservationService.consumes)
      this.consumers.on(def.name, RESTAURANT_STAY_CONSUMER, (envelope) =>
        this.reservations.onStayEvent(envelope),
      );
  }
}
