import { Global, Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { GuestAnonymized, NotificationRequested } from '@hotella/contracts-events';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import {
  AlertsController,
  ApprovalsController,
  NotificationsController,
  OperationsController,
  SlaAdminController,
  WorkflowsController,
} from './api/controllers';
import { ActorStore } from '@hotella/platform-auth';
import { AlertAdminService, AlertService } from './application/alert.service';
import { ApprovalAdminService, ApprovalService } from './application/approval.service';
import { EMAIL_CHANNEL, SmtpEmailChannel } from './application/email.channel';
import { FcmPushChannel, PUSH_CHANNEL } from './application/push.channel';
import { NotificationRules } from './application/notification-rules';
import { NotificationInboxService, NotificationService } from './application/notification.service';
import { OperationsQueryService } from './application/queries';
import { SlaAdminService } from './application/sla-admin.service';
import { SlaMonitor, SlaService } from './application/sla.service';
import { TaskService } from './application/task.service';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import {
  WorkflowAdminService,
  WorkflowEngine,
  WorkflowRegistry,
} from './application/workflow.service';
import { OperationsRepositories } from './infrastructure/repositories';
import { SlaRepositories } from './infrastructure/sla-repositories';
import { NotificationRepositories } from './infrastructure/notification-repositories';
import { WorkflowRepositories } from './infrastructure/workflow-repositories';
import { OPERATIONS_MANIFEST } from './manifest';
import { OPERATIONS_API } from './public';
import { OperationsPublicApiService } from './public-api.service';

/** Repeatable jobs of the worker: SLA breaches/escalations and approval expiry. */
export const SLA_SWEEP_JOB = 'ops.sla.sweep';
export const APPROVAL_EXPIRY_JOB = 'ops.approval.expire';
export const NOTIFICATION_DELIVERY_JOB = 'ops.notification.deliver';
/** Inbox consumers of the worker: notification rules and the dispatcher. */
export const NOTIFICATION_RULES_CONSUMER = 'ops.notification-rules';
export const NOTIFICATION_DISPATCH_CONSUMER = 'ops.notification-dispatcher';
/** Anonymization clears free text that may quote the guest from their work (Spec §69). */
export const GUEST_ANONYMIZATION_CONSUMER = 'ops.guest-anonymization';
const SLA_SWEEP_EVERY_MS = 15_000;
const APPROVAL_EXPIRY_EVERY_MS = 60_000;
const NOTIFICATION_DELIVERY_EVERY_MS = 10_000;

/**
 * The engine without HTTP routes: repositories, the kind registry, SLA and OPERATIONS_API. Global so every module can
 * inject OPERATIONS_API and register its work-item kinds.
 */
@Global()
@Module({
  providers: [
    // The request actor (CLS) for processes without the auth module (the worker).
    ActorStore,
    OperationsRepositories,
    SlaRepositories,
    WorkflowRepositories,
    NotificationRepositories,
    WorkItemKindRegistry,
    WorkflowRegistry,
    AlertService,
    SlaService,
    WorkService,
    ApprovalService,
    WorkflowEngine,
    { provide: EMAIL_CHANNEL, useClass: SmtpEmailChannel },
    { provide: PUSH_CHANNEL, useClass: FcmPushChannel },
    NotificationService,
    NotificationRules,
    OperationsPublicApiService,
    { provide: OPERATIONS_API, useExisting: OperationsPublicApiService },
  ],
  exports: [
    OPERATIONS_API,
    WorkService,
    WorkItemKindRegistry,
    OperationsRepositories,
    SlaRepositories,
    AlertService,
    SlaService,
    WorkflowRepositories,
    WorkflowRegistry,
    ApprovalService,
    WorkflowEngine,
    NotificationRepositories,
    NotificationService,
    NotificationRules,
  ],
})
export class OperationsCoreModule {}

/** Staff API and manifest, for the API process. */
@Module({
  imports: [OperationsCoreModule],
  controllers: [
    OperationsController,
    SlaAdminController,
    AlertsController,
    WorkflowsController,
    ApprovalsController,
    NotificationsController,
  ],
  providers: [
    OperationsQueryService,
    TaskService,
    SlaAdminService,
    AlertAdminService,
    WorkflowAdminService,
    ApprovalAdminService,
    NotificationInboxService,
  ],
})
export class OperationsModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(OPERATIONS_MANIFEST);
  }
}

/**
 * Worker side, with the full engine (approval expiries move workflows): the SLA sweep (every 15 s; deadlines are
 * minute-based), approval expiry (every minute) and e-mail delivery (every 10 s) on `critical-operational`, plus the
 * notification rules and dispatcher as event consumers. The worker composes the route-free
 * modules of the contexts the engine looks up (OrganizationCoreModule, IdentityDirectoryModule, GuestCoreModule).
 */
@Module({ imports: [OperationsCoreModule], providers: [SlaMonitor], exports: [SlaMonitor] })
export class OperationsWorkerModule implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueRegistry,
    private readonly consumers: EventConsumerRegistry,
    private readonly monitor: SlaMonitor,
    private readonly approvals: ApprovalService,
    private readonly notifications: NotificationService,
    private readonly rules: NotificationRules,
    private readonly work: WorkService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumers.onJob(SLA_SWEEP_JOB, async () => {
      await this.monitor.sweep();
    });
    this.consumers.onJob(APPROVAL_EXPIRY_JOB, async () => {
      await this.approvals.expireDue();
    });
    this.consumers.onJob(NOTIFICATION_DELIVERY_JOB, async () => {
      await this.notifications.deliverDue();
    });
    for (const def of NotificationRules.consumes)
      this.consumers.on(def.name, NOTIFICATION_RULES_CONSUMER, (envelope) =>
        this.rules.apply(envelope),
      );
    this.consumers.on(
      NotificationRequested.name,
      NOTIFICATION_DISPATCH_CONSUMER,
      async (envelope) => {
        const p = envelope.payload as { intent_id: string };
        if (envelope.tenant_id)
          await this.notifications.dispatch({ tenantId: envelope.tenant_id }, p.intent_id);
      },
    );
    this.consumers.on(GuestAnonymized.name, GUEST_ANONYMIZATION_CONSUMER, async (envelope) => {
      if (!envelope.tenant_id) return;
      const e = GuestAnonymized.parse(envelope);
      await this.work.redactGuestText(envelope.tenant_id, e.payload.guest_id);
    });
    if (!this.config.worker.schedulerEnabled) return;
    for (const [job, every] of [
      [SLA_SWEEP_JOB, SLA_SWEEP_EVERY_MS],
      [APPROVAL_EXPIRY_JOB, APPROVAL_EXPIRY_EVERY_MS],
      [NOTIFICATION_DELIVERY_JOB, NOTIFICATION_DELIVERY_EVERY_MS],
    ] as const) {
      await this.queues.queue('critical-operational').upsertJobScheduler(
        job,
        { every },
        {
          name: job,
          data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
          opts: { removeOnComplete: 10, removeOnFail: 50 },
        },
      );
      this.logger.info({ job, every_ms: every }, 'operations schedule armed');
    }
  }
}
