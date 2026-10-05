import { Global, Inject, Module, type OnModuleInit, Optional } from '@nestjs/common';
import {
  AI_INSIGHT_DETECTORS,
  AI_TOOL_REGISTRY,
  type AiToolRegistrar,
  type InsightDetectorRegistrar,
} from '@hotella/domain-ai/public';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
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
import { ArrivalRiskService } from './application/arrival-risk.service';
import { HK_JOB_KIND, JobService } from './application/job.service';
import { HousekeepingPublicApiService } from './application/public-api.service';
import { ReadinessService } from './application/readiness.service';
import { RoomStateService } from './application/room-state.service';
import { setRoomSignalTool } from './application/signal-tool';
import { HOUSEKEEPING_SETTINGS } from './domain/settings';
import { HousekeepingRepositories } from './infrastructure/repositories';
import { HOUSEKEEPING_MANIFEST } from './manifest';
import { HOUSEKEEPING_API, type HousekeepingPublicApi } from './public';

/** Inbox consumer of the worker: the room projection follows the PMS (exactly once per event). */
export const ROOM_STATE_CONSUMER = 'hk.room-states';
/** Inbox consumer of the worker: engineering work at a room changes its readiness. */
export const READINESS_CONSUMER = 'hk.readiness';
/** Inbox consumer of the worker: cleaning jobs are created by check-outs and follow their work items. */
export const JOB_CONSUMER = 'hk.jobs';
/** Hourly job: each property's stayover cleans once its configured local hour has passed (idempotent per day). */
export const STAYOVER_JOB = 'hk.stayover.generate';
const STAYOVER_EVERY_MS = 60 * 60 * 1000;

/**
 * Housekeeping without HTTP routes (API and worker): repositories, the room projection, cleaning jobs and
 * `HOUSEKEEPING_API`. Registers the `HK_JOB` work kind with the operations engine and the concierge's
 * `housekeeping.set_room_signal` tool.
 */
@Global()
@Module({
  providers: [
    HousekeepingRepositories,
    ReadinessService,
    RoomStateService,
    JobService,
    ArrivalRiskService,
    HousekeepingPublicApiService,
    { provide: HOUSEKEEPING_API, useExisting: HousekeepingPublicApiService },
  ],
  exports: [
    HousekeepingRepositories,
    ReadinessService,
    RoomStateService,
    JobService,
    ArrivalRiskService,
    HOUSEKEEPING_API,
  ],
})
export class HousekeepingCoreModule implements OnModuleInit {
  constructor(
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Inject(HOUSEKEEPING_API) private readonly housekeeping: HousekeepingPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    private readonly arrivals: ArrivalRiskService,
    @Optional() @Inject(AI_TOOL_REGISTRY) private readonly tools?: AiToolRegistrar,
    @Optional() @Inject(AI_INSIGHT_DETECTORS) private readonly detectors?: InsightDetectorRegistrar,
  ) {}
  onModuleInit(): void {
    // Tomorrow's risky arrivals become an insight for the duty manager (when the AI context is composed).
    this.detectors?.register(this.arrivals.insightDetector());
    this.ops.registerWorkItemKind({
      code: HK_JOB_KIND,
      module: 'hk',
      descriptionKey: 'hk.work_kind.job',
    });
    // The concierge's tool, when the AI tools are composed (API and worker).
    this.tools?.register(setRoomSignalTool(this.housekeeping, this.guests));
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
    private readonly readiness: ReadinessService,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    for (const def of RoomStateService.consumes)
      this.consumers.on(def.name, ROOM_STATE_CONSUMER, (envelope) => this.rooms.applyPms(envelope));
    for (const def of JobService.consumes)
      this.consumers.on(def.name, JOB_CONSUMER, (envelope) => this.jobs.apply(envelope));
    for (const def of ReadinessService.consumes)
      this.consumers.on(def.name, READINESS_CONSUMER, (envelope) => this.readiness.apply(envelope));
    this.consumers.onJob(STAYOVER_JOB, async () => {
      await this.jobs.generateDaily();
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
