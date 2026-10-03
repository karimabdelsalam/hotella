import { Global, Inject, Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { ApprovalDecided } from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { AI_AGENT_AUTHORIZER, AI_POLICY_STAGE } from '@hotella/platform-auth';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import { AiAdminController } from './api/controllers';
import { AiAdminService } from './application/admin.service';
import { ModelGatewayService } from './application/gateway.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { AI_ACTION_APPROVAL, ToolExecutor } from './application/tools/executor';
import { ProposalSettler } from './application/tools/proposal-settler';
import { ToolRegistry } from './application/tools/registry';
import { AiPolicyStage, ScopedAgentAuthorizer } from './application/tools/scope';
import { ToolsV1 } from './application/tools/v1';
import { AI_SETTINGS } from './domain/settings';
import { AiRepositories } from './infrastructure/repositories';
import { AI_MANIFEST } from './manifest';
import { MODEL_GATEWAY } from './public';

/** Inbox consumer of the worker: rejected or expired AI proposals are closed. */
export const AI_PROPOSAL_SETTLE_CONSUMER = 'ai.proposal-settle';

/** The AI context without HTTP routes (API and worker): repositories, provider adapters and `MODEL_GATEWAY`. */
@Global()
@Module({
  providers: [
    AiRepositories,
    ModelProviderRegistry,
    ModelGatewayService,
    ProposalSettler,
    { provide: MODEL_GATEWAY, useExisting: ModelGatewayService },
  ],
  exports: [
    AiRepositories,
    ModelProviderRegistry,
    ModelGatewayService,
    ProposalSettler,
    MODEL_GATEWAY,
  ],
})
export class AiCoreModule {}

/**
 * The tool registry and executor (Spec §31–§34) with tools v1, and the `AI_ACTION` approval kind. Needs the
 * ActionGate (AuthModule) and the public APIs the tools act through.
 */
@Module({
  imports: [AiCoreModule],
  providers: [ToolRegistry, ToolsV1, ToolExecutor],
  exports: [ToolRegistry, ToolExecutor],
})
export class AiToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly v1: ToolsV1,
    private readonly executor: ToolExecutor,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
  ) {}
  onModuleInit(): void {
    this.v1.registerInto(this.registry);
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
  controllers: [AiAdminController],
  providers: [AiAdminService],
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

/** Worker side: closes the proposals of rejected or expired `AI_ACTION` approvals. */
@Module({ imports: [AiCoreModule] })
export class AiWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly settler: ProposalSettler,
  ) {}
  onModuleInit(): void {
    this.consumers.on(ApprovalDecided.name, AI_PROPOSAL_SETTLE_CONSUMER, async (envelope) => {
      if (!envelope.tenant_id) return;
      const e = ApprovalDecided.parse(envelope);
      if (e.payload.kind !== AI_ACTION_APPROVAL || e.payload.outcome === 'APPROVED') return;
      await this.settler.settle(envelope.tenant_id, e.payload.approval_id, e.payload.outcome);
    });
  }
}
