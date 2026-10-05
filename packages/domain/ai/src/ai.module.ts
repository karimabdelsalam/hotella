import { Global, Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ApprovalDecided, MessageReceived, ReplyDraftUsed } from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { AI_AGENT_AUTHORIZER, AI_POLICY_STAGE } from '@hotella/platform-auth';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import {
  AiAdminController,
  AiEvaluationController,
  AiExecutionsController,
  AiInsightsController,
  AiManagerController,
  AiTwinController,
} from './api/controllers';
import { AiAdminService } from './application/admin.service';
import { AGENT_DEFINITIONS, AgentCatalog } from './application/agent-catalog';
import { CONCIERGE_AGENT, ConciergeRuntime } from './application/concierge.runtime';
import { StaffAssistantRuntime } from './application/staff-assistant.runtime';
import { ContextEngine } from './application/context-engine';
import { AI_EVALUATION_JOB, EvaluationService } from './application/evaluation.service';
import { ExecutionAuditService } from './application/execution-audit.service';
import { FeedbackRecorder } from './application/feedback-recorder';
import {
  InsightDetectorRegistry,
  InsightEngine,
  InsightService,
} from './application/insights.service';
import { ManagerService } from './application/manager.service';
import { PulseService } from './application/pulse.service';
import { SIGNAL_EVENTS, SignalRecorder } from './application/signal-recorder';
import { ModelGatewayService } from './application/gateway.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { AI_ACTION_APPROVAL, ToolExecutor } from './application/tools/executor';
import { ProposalSettler } from './application/tools/proposal-settler';
import { ToolRegistry } from './application/tools/registry';
import { AiPolicyStage, ScopedAgentAuthorizer } from './application/tools/scope';
import { TWIN_EVENTS } from './application/twin-projection';
import { TwinLabelRegistry, TwinProjector, TwinService } from './application/twin.service';
import { IntelligenceTools } from './application/tools/intelligence';
import { ToolsV1 } from './application/tools/v1';
import { BUILT_IN_AGENTS, GUEST_CONCIERGE } from './domain/agents';
import { AI_SETTINGS } from './domain/settings';
import { EvaluationRepositories } from './infrastructure/evaluation-repositories';
import { AiRepositories } from './infrastructure/repositories';
import { InsightRepositories } from './infrastructure/insight-repositories';
import { TwinRepositories } from './infrastructure/twin-repositories';
import { AI_MANIFEST } from './manifest';
import {
  AI_INSIGHT_DETECTORS,
  AI_TOOL_REGISTRY,
  AI_TWIN_LABELS,
  MODEL_GATEWAY,
  STAFF_ASSISTANT_API,
} from './public';

/** Inbox consumers of the worker: rejected or expired AI proposals are closed; guest messages wake the concierge. */
export const AI_PROPOSAL_SETTLE_CONSUMER = 'ai.proposal-settle';
export const AI_CONCIERGE_CONSUMER = 'ai.concierge';
export const AI_FEEDBACK_CONSUMER = 'ai.feedback';
/** The operational twin's projection (one consumer for every event it follows). */
export const AI_TWIN_CONSUMER = 'ai.twin';
/** Hourly: the insight detectors of every active property (BUILD_PLAN 12.4). */
export const AI_INSIGHTS_JOB = 'ai.insights.detect';
const INSIGHTS_EVERY_MS = 60 * 60 * 1000;
/** The concierge runs as a job on `background-ai`, never on the realtime queue that delivered the message. */
export const AI_CONCIERGE_JOB = 'ai.concierge.run';

/** The AI context without HTTP routes (API and worker): repositories, provider adapters and `MODEL_GATEWAY`. */
@Global()
@Module({
  providers: [
    AiRepositories,
    EvaluationRepositories,
    TwinRepositories,
    TwinLabelRegistry,
    { provide: AI_TWIN_LABELS, useExisting: TwinLabelRegistry },
    TwinProjector,
    InsightRepositories,
    SignalRecorder,
    InsightDetectorRegistry,
    { provide: AI_INSIGHT_DETECTORS, useExisting: InsightDetectorRegistry },
    InsightEngine,
    PulseService,
    ModelProviderRegistry,
    ModelGatewayService,
    ProposalSettler,
    { provide: AGENT_DEFINITIONS, useValue: BUILT_IN_AGENTS },
    { provide: CONCIERGE_AGENT, useValue: GUEST_CONCIERGE.code },
    AgentCatalog,
    FeedbackRecorder,
    { provide: MODEL_GATEWAY, useExisting: ModelGatewayService },
  ],
  exports: [
    AiRepositories,
    EvaluationRepositories,
    ModelProviderRegistry,
    ModelGatewayService,
    ProposalSettler,
    AgentCatalog,
    FeedbackRecorder,
    MODEL_GATEWAY,
    CONCIERGE_AGENT,
    TwinRepositories,
    TwinLabelRegistry,
    AI_TWIN_LABELS,
    TwinProjector,
    InsightRepositories,
    SignalRecorder,
    InsightDetectorRegistry,
    AI_INSIGHT_DETECTORS,
    InsightEngine,
    PulseService,
  ],
})
export class AiCoreModule {}

/**
 * The tool registry and executor (Spec §31–§34) with tools v1, and the `AI_ACTION` approval kind. Needs the
 * ActionGate (AuthModule) and the public APIs the tools act through. Global, so owning contexts can register their
 * own tools through `AI_TOOL_REGISTRY`.
 */
@Global()
@Module({
  imports: [AiCoreModule],
  providers: [
    ToolRegistry,
    { provide: AI_TOOL_REGISTRY, useExisting: ToolRegistry },
    ToolsV1,
    IntelligenceTools,
    ToolExecutor,
    ContextEngine,
    ConciergeRuntime,
    StaffAssistantRuntime,
    { provide: STAFF_ASSISTANT_API, useExisting: StaffAssistantRuntime },
    EvaluationService,
  ],
  exports: [
    EvaluationService,
    ToolRegistry,
    AI_TOOL_REGISTRY,
    ToolExecutor,
    ContextEngine,
    ConciergeRuntime,
    STAFF_ASSISTANT_API,
    StaffAssistantRuntime,
    IntelligenceTools,
  ],
})
export class AiToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly v1: ToolsV1,
    private readonly intelligence: IntelligenceTools,
    private readonly executor: ToolExecutor,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
  ) {}
  onModuleInit(): void {
    this.v1.registerInto(this.registry);
    this.intelligence.registerInto(this.registry);
    this.ops.registerApprovalKind({
      code: AI_ACTION_APPROVAL,
      module: 'ai',
      descriptionKey: 'ai.approval.ai_action',
      handler: (approval) => this.executor.executeApproved(approval),
    });
  }
}

/** Administration API, tools, settings and manifest, for the API process. */
@Module({
  imports: [AiCoreModule, AiToolsModule],
  controllers: [
    AiAdminController,
    AiExecutionsController,
    AiEvaluationController,
    AiTwinController,
    AiInsightsController,
    AiManagerController,
  ],
  providers: [AiAdminService, ExecutionAuditService, TwinService, InsightService, ManagerService],
})
export class AiModule implements OnModuleInit {
  /**
   * ActionGate stages for AI agents: `AuthModule.forRoot({ stages: [...AiModule.gateStages()] })`. Without them every
   * AI actor is refused (default deny).
   */
  static gateStages(): Provider[] {
    return [
      { provide: AI_AGENT_AUTHORIZER, useValue: new ScopedAgentAuthorizer() },
      { provide: AI_POLICY_STAGE, useValue: new AiPolicyStage() },
    ];
  }

  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(AI_MANIFEST);
    this.settings.register(...AI_SETTINGS);
  }
}

/**
 * Worker side (needs the ActionGate: `AuthModule.forRoot({ httpGuard: false, stages: [...AiModule.gateStages()] })`):
 * a guest message in an AI conversation queues a concierge run on `background-ai`; staff use of a draft becomes
 * feedback; rejected or expired proposals are closed.
 */
@Module({ imports: [AiCoreModule, AiToolsModule] })
export class AiWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly queues: QueueRegistry,
    private readonly settler: ProposalSettler,
    private readonly runtime: ConciergeRuntime,
    private readonly feedback: FeedbackRecorder,
    private readonly evaluation: EvaluationService,
    private readonly twin: TwinProjector,
    private readonly signals: SignalRecorder,
    private readonly insights: InsightEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectLogger() private readonly logger: Logger,
  ) {}
  async onModuleInit(): Promise<void> {
    this.consumers.on(ApprovalDecided.name, AI_PROPOSAL_SETTLE_CONSUMER, async (envelope) => {
      if (!envelope.tenant_id) return;
      const e = ApprovalDecided.parse(envelope);
      if (e.payload.kind !== AI_ACTION_APPROVAL || e.payload.outcome === 'APPROVED') return;
      await this.settler.settle(envelope.tenant_id, e.payload.approval_id, e.payload.outcome);
    });
    this.consumers.on(MessageReceived.name, AI_CONCIERGE_CONSUMER, async (envelope) => {
      const e = MessageReceived.parse(envelope);
      if (!envelope.tenant_id || !e.payload.stay_id) return;
      // One run per message (the job id dedupes a redelivered event).
      await this.queues.enqueue(
        'background-ai',
        AI_CONCIERGE_JOB,
        {
          tenantId: envelope.tenant_id,
          conversationId: e.payload.conversation_id,
          messageId: e.payload.message_id,
        },
        { jobId: `concierge-${e.payload.message_id}` },
      );
    });
    this.consumers.onJob<{ tenantId: string; conversationId: string; messageId: string }>(
      AI_CONCIERGE_JOB,
      async (data) => {
        await this.runtime.onGuestMessage(data);
      },
    );
    this.consumers.on(ReplyDraftUsed.name, AI_FEEDBACK_CONSUMER, async (envelope) => {
      await this.feedback.onDraftUsed(envelope);
    });
    // Regression runs of agent versions (BUILD_PLAN 12.1): the model calls are slow, so they run here, not in the API.
    this.consumers.onJob<{ runId: string }>(AI_EVALUATION_JOB, async (data) => {
      await this.evaluation.execute(data.runId);
    });
    // The operational twin (BUILD_PLAN 12.3): a projection of what other contexts announce.
    // The insight signals ride the same consumer, after the twin (they read the room or department it knows).
    for (const name of new Set([...TWIN_EVENTS, ...SIGNAL_EVENTS]))
      this.consumers.on(name, AI_TWIN_CONSUMER, async (envelope) => {
        await this.twin.project(envelope);
        await this.signals.record(envelope);
      });
    this.consumers.onJob(AI_INSIGHTS_JOB, async () => {
      await this.insights.sweep();
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('background-ai').upsertJobScheduler(
      AI_INSIGHTS_JOB,
      { every: INSIGHTS_EVERY_MS },
      {
        name: AI_INSIGHTS_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 50 },
      },
    );
    this.logger.info(
      { job: AI_INSIGHTS_JOB, every_ms: INSIGHTS_EVERY_MS },
      'insight schedule armed',
    );
  }
}
