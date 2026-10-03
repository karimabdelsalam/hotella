import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { GuestRoomSignalsController, HousekeepingController } from './api/controllers';
import { HousekeepingPublicApiService } from './application/public-api.service';
import { RoomStateService } from './application/room-state.service';
import { HousekeepingRepositories } from './infrastructure/repositories';
import { HOUSEKEEPING_MANIFEST } from './manifest';
import { HOUSEKEEPING_API } from './public';

/** Inbox consumer of the worker: the room projection follows the PMS (exactly once per event). */
export const ROOM_STATE_CONSUMER = 'hk.room-states';

/** Housekeeping without HTTP routes (API and worker): repositories, the room projection and `HOUSEKEEPING_API`. */
@Global()
@Module({
  providers: [
    HousekeepingRepositories,
    RoomStateService,
    HousekeepingPublicApiService,
    { provide: HOUSEKEEPING_API, useExisting: HousekeepingPublicApiService },
  ],
  exports: [HousekeepingRepositories, RoomStateService, HOUSEKEEPING_API],
})
export class HousekeepingCoreModule {}

/** Staff and guest API and manifest, for the API process. */
@Module({
  imports: [HousekeepingCoreModule],
  controllers: [HousekeepingController, GuestRoomSignalsController],
})
export class HousekeepingModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(HOUSEKEEPING_MANIFEST);
  }
}

/** Worker side: the projection follows check-in, check-out, room moves and PMS room statuses. */
@Module({ imports: [HousekeepingCoreModule] })
export class HousekeepingWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly rooms: RoomStateService,
  ) {}
  onModuleInit(): void {
    for (const def of RoomStateService.consumes)
      this.consumers.on(def.name, ROOM_STATE_CONSUMER, (envelope) => this.rooms.applyPms(envelope));
  }
}
