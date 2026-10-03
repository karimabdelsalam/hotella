import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import {
  GuestRoomSignalsController,
  HousekeepingController,
  HousekeepingJobsController,
} from './api/controllers';
import { HK_JOB_KIND, JobService } from './application/job.service';
import { HousekeepingPublicApiService } from './application/public-api.service';
import { RoomStateService } from './application/room-state.service';
import { HOUSEKEEPING_SETTINGS } from './domain/settings';
import { HousekeepingRepositories } from './infrastructure/repositories';
import { HOUSEKEEPING_MANIFEST } from './manifest';
import { HOUSEKEEPING_API } from './public';

/** Inbox consumer of the worker: the room projection follows the PMS (exactly once per event). */
export const ROOM_STATE_CONSUMER = 'hk.room-states';
/** Inbox consumer of the worker: cleaning jobs are created by check-outs and follow their work items. */
export const JOB_CONSUMER = 'hk.jobs';
/** Hourly job: each property's stayover cleans once its configured local hour has passed (idempotent per day). */
export const STAYOVER_JOB = 'hk.stayover.generate';
const STAYOVER_EVERY_MS = 60 * 60 * 1000;

/**
 * Housekeeping without HTTP routes (API and worker): repositories, the room projection, cleaning jobs and
 * `HOUSEKEEPING_API`. Registers the `HK_JOB` work kind with the operations engine.
 */
@Global()
@Module({
  providers: [
    HousekeepingRepositories,
    RoomStateService,
    JobService,
    HousekeepingPublicApiService,
    { provide: HOUSEKEEPING_API, useExisting: HousekeepingPublicApiService },
  ],
  exports: [HousekeepingRepositories, RoomStateService, JobService, HOUSEKEEPING_API],
})
export class HousekeepingCoreModule implements OnModuleInit {
  constructor(@Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi) {}
  onModuleInit(): void {
    this.ops.registerWorkItemKind({
      code: HK_JOB_KIND,
      module: 'hk',
      descriptionKey: 'hk.work_kind.job',
    });
  }
}

/** Staff and guest API, settings and manifest, for the API process. */
@Module({
  imports: [HousekeepingCoreModule],
  controllers: [HousekeepingController, HousekeepingJobsController, GuestRoomSignalsController],
})
export class HousekeepingModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(HOUSEKEEPING_MANIFEST);
    this.settings.register(...HOUSEKEEPING_SETTINGS);
  }
}

/**
 * Worker side: the projection follows check-in, check-out, room moves and PMS room statuses; jobs are created by
 * check-outs and follow their work items; the stayover sweep runs hourly on `normal`.
 */
@Module({ imports: [HousekeepingCoreModule] })
export class HousekeepingWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly rooms: RoomStateService,
    private readonly jobs: JobService,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    for (const def of RoomStateService.consumes)
      this.consumers.on(def.name, ROOM_STATE_CONSUMER, (envelope) => this.rooms.applyPms(envelope));
    for (const def of JobService.consumes)
      this.consumers.on(def.name, JOB_CONSUMER, (envelope) => this.jobs.apply(envelope));
    this.consumers.onJob(STAYOVER_JOB, async () => {
      await this.jobs.generateStayovers();
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('normal').upsertJobScheduler(
      STAYOVER_JOB,
      { every: STAYOVER_EVERY_MS },
      {
        name: STAYOVER_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
    this.logger.info(
      { job: STAYOVER_JOB, every_ms: STAYOVER_EVERY_MS },
      'housekeeping schedule armed',
    );
  }
}
