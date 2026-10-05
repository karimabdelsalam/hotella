import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { IdempotentConsumer } from '@hotella/platform-events';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import {
  GuestAccessController,
  GuestProfilesController,
  RoomAccessController,
  StaysController,
} from './api/controllers';
import { RoomAccessService } from './application/room-access.service';
import { GuestAccessAdminService, GuestAccessService } from './application/access.service';
import { GUEST_SETTINGS } from './domain/settings';
import { AccessRepositories } from './infrastructure/access-repositories';
import { SettingsRegistry } from '@hotella/platform-settings';
import { GuestQueryService, StayQueryService } from './application/queries';
import { StayProjector } from './application/stay-projector';
import { StayReconciler } from './application/stay-reconciler';
import { GuestDataService } from './application/guest-data.service';
import { GuestRepositories } from './infrastructure/repositories';
import { SpendRepositories } from './infrastructure/spend-repositories';
import { StaySpendService } from './application/spend.service';
import { GUEST_MANIFEST } from './manifest';
import { GUEST_API } from './public';
import { GuestPublicApiService } from './public-api.service';

/** Consumer name in the inbox: one exactly-once effect per canonical event for the stay projection. */
export const STAY_PROJECTOR_CONSUMER = 'guest.stay-projector';
export const STAY_RECONCILER_CONSUMER = 'guest.stay-reconciler';
/** POS checks become spend facts of stays (BUILD_PLAN 13.5). */
export const STAY_SPEND_CONSUMER = 'guest.pos-spend';

/**
 * The guest context without HTTP routes: repositories, the stay projector and GUEST_API. Global so other contexts
 * inject GUEST_API without importing this module; the worker imports it to run the projector.
 */
@Global()
@Module({
  providers: [
    GuestRepositories,
    AccessRepositories,
    GuestAccessService,
    StayProjector,
    StayReconciler,
    SpendRepositories,
    StaySpendService,
    GuestPublicApiService,
    { provide: GUEST_API, useExisting: GuestPublicApiService },
  ],
  exports: [
    GUEST_API,
    StaySpendService,
    StayProjector,
    StayReconciler,
    GuestRepositories,
    AccessRepositories,
    GuestAccessService,
  ],
})
export class GuestCoreModule {}

/** Staff read API and manifest, for the API process. */
@Module({
  imports: [GuestCoreModule],
  controllers: [
    StaysController,
    GuestProfilesController,
    GuestAccessController,
    RoomAccessController,
  ],
  providers: [
    StayQueryService,
    GuestQueryService,
    GuestDataService,
    GuestAccessAdminService,
    RoomAccessService,
  ],
})
export class GuestModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(GUEST_MANIFEST);
    this.settings.register(...GUEST_SETTINGS);
  }
}

/** Subscribes the stay projector to the canonical PMS events (worker process). */
@Module({ imports: [GuestCoreModule] })
export class GuestEventsModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly projector: StayProjector,
    private readonly reconciler: StayReconciler,
    private readonly spend: StaySpendService,
  ) {}
  onModuleInit(): void {
    for (const def of StayProjector.consumes)
      this.consumers.on(def.name, STAY_PROJECTOR_CONSUMER, (envelope) =>
        this.projector.apply(envelope),
      );
    for (const def of StayReconciler.consumes)
      this.consumers.on(def.name, STAY_RECONCILER_CONSUMER, (envelope) =>
        this.reconciler.apply(envelope),
      );
    for (const def of StaySpendService.consumes)
      this.consumers.on(def.name, STAY_SPEND_CONSUMER, (envelope) => this.spend.apply(envelope));
  }
}

/** Test and tooling helper: run the reconciler exactly once for an envelope, as the worker does. */
export function reconcileOnce(idempotency: IdempotentConsumer, reconciler: StayReconciler) {
  return (envelope: Parameters<StayReconciler['apply']>[0]) =>
    idempotency.once(STAY_RECONCILER_CONSUMER, envelope, (e) => reconciler.apply(e));
}

/** Test and tooling helper: apply one canonical envelope exactly once, as the worker does. */
export function projectOnce(idempotency: IdempotentConsumer, projector: StayProjector) {
  return (envelope: Parameters<StayProjector['apply']>[0]) =>
    idempotency.once(STAY_PROJECTOR_CONSUMER, envelope, (e) => projector.apply(e));
}

/** Test and tooling helper: record one POS check exactly once, as the worker does. */
export function recordSpendOnce(idempotency: IdempotentConsumer, spend: StaySpendService) {
  return (envelope: Parameters<StaySpendService['apply']>[0]) =>
    idempotency.once(STAY_SPEND_CONSUMER, envelope, (e) => spend.apply(e));
}
