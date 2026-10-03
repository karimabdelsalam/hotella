import { Global, Inject, Module, type OnModuleInit, Optional } from '@nestjs/common';
import { ApprovalDecided } from '@hotella/contracts-events';
import { AI_TOOL_REGISTRY, type AiToolRegistrar } from '@hotella/domain-ai/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { EventConsumerRegistry } from '@hotella/platform-queue';
import { SettingsRegistry } from '@hotella/platform-settings';
import { CategoriesController, ComplaintsController } from './api/controllers';
import { RelationsAiTools } from './application/ai-tools';
import { CandidateService } from './application/candidate.service';
import { ComplaintService } from './application/complaint.service';
import { RelationsPublicApiService } from './application/public-api.service';
import { RECOVERY_ACTION_APPROVAL, RecoveryService } from './application/recovery.service';
import { RELATIONS_SETTINGS } from './domain/settings';
import { RelationsRepositories } from './infrastructure/repositories';
import { RELATIONS_MANIFEST } from './manifest';
import { RELATIONS_API } from './public';

/** Inbox consumer of the worker: recovery whose approval was rejected or expired is closed as REJECTED. */
export const RECOVERY_SETTLE_CONSUMER = 'relations.recovery-settle';

/**
 * Guest relations without HTTP routes (API and worker): repositories, complaints, candidates, recovery and
 * `RELATIONS_API`. Registers the `RECOVERY_ACTION` approval kind and, when the AI tools are composed, the concierge's
 * `relations.suggest_complaint` tool.
 */
@Global()
@Module({
  providers: [
    RelationsRepositories,
    ComplaintService,
    CandidateService,
    RecoveryService,
    RelationsAiTools,
    RelationsPublicApiService,
    { provide: RELATIONS_API, useExisting: RelationsPublicApiService },
  ],
  exports: [
    RelationsRepositories,
    ComplaintService,
    CandidateService,
    RecoveryService,
    RELATIONS_API,
  ],
})
export class RelationsCoreModule implements OnModuleInit {
  constructor(
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    private readonly recovery: RecoveryService,
    private readonly aiTools: RelationsAiTools,
    @Optional() @Inject(AI_TOOL_REGISTRY) private readonly tools?: AiToolRegistrar,
  ) {}
  onModuleInit(): void {
    this.ops.registerApprovalKind({
      code: RECOVERY_ACTION_APPROVAL,
      module: 'relations',
      descriptionKey: 'relations.approval.recovery_action',
      handler: (approval) => this.recovery.approved(approval),
    });
    if (this.tools) this.aiTools.registerInto(this.tools);
  }
}

/** Staff API, settings and manifest, for the API process. */
@Module({
  imports: [RelationsCoreModule],
  controllers: [CategoriesController, ComplaintsController],
})
export class RelationsModule implements OnModuleInit {
  constructor(
    private readonly manifests: ManifestRegistry,
    private readonly settings: SettingsRegistry,
  ) {}
  onModuleInit(): void {
    this.manifests.register(RELATIONS_MANIFEST);
    this.settings.register(...RELATIONS_SETTINGS);
  }
}

/** Worker side: rejected or expired recovery approvals settle the recovery. */
@Module({ imports: [RelationsCoreModule] })
export class RelationsWorkerModule implements OnModuleInit {
  constructor(
    private readonly consumers: EventConsumerRegistry,
    private readonly recovery: RecoveryService,
  ) {}
  onModuleInit(): void {
    this.consumers.on(ApprovalDecided.name, RECOVERY_SETTLE_CONSUMER, async (envelope) => {
      if (!envelope.tenant_id) return;
      const e = ApprovalDecided.parse(envelope);
      if (e.payload.kind !== RECOVERY_ACTION_APPROVAL || e.payload.outcome === 'APPROVED') return;
      await this.recovery.settle(envelope.tenant_id, e.payload.approval_id, e.payload.outcome);
    });
  }
}
