import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { FeatureFlagService } from '@hotella/platform-flags';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { ActorStore, type RequestActor } from './actor';
import {
  AI_AGENT_AUTHORIZER,
  type AiAgentAuthorizer,
  PERMISSION_RESOLVER,
  type PermissionResolver,
} from './contracts';

/** What an application service is about to do (Spec §60 unified action gate). */
export interface ActionRequest {
  /** Permission code, e.g. `org.property.manage`. */
  readonly action: string;
  readonly tenantId: string | null;
  readonly propertyId?: string | null;
  /** Entitlement capability required (Spec §58), e.g. `HOUSEKEEPING`; checked by the licensing context from Phase 11. */
  readonly entitlement?: string;
  /** Feature flag gating this code path (Spec §73). */
  readonly feature?: string;
  /** Connector capability required (Spec §47), e.g. `ROOM_STATUS_WRITE`. */
  readonly connectorCapability?: string;
  /** AI tool risk when the actor is an AI agent (Spec §32). */
  readonly aiRisk?: 'READ' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Override the actor (jobs, system flows); default is the request actor. */
  readonly actor?: RequestActor;
}

export interface GateStage {
  readonly name: string;
  check(request: ActionRequest, actor: RequestActor): Promise<void>;
}

/** Pluggable stages: later phases replace the pass-through defaults (entitlement in Phase 11, AI policy in Phase 6, connector capability in Phase 2/10). */
export const ENTITLEMENT_STAGE = Symbol('ENTITLEMENT_STAGE');
export const CONFIGURATION_STAGE = Symbol('CONFIGURATION_STAGE');
export const CONNECTOR_CAPABILITY_STAGE = Symbol('CONNECTOR_CAPABILITY_STAGE');
export const AI_POLICY_STAGE = Symbol('AI_POLICY_STAGE');

export class PassThroughStage implements GateStage {
  constructor(readonly name: string) {}
  async check(): Promise<void> {
    return;
  }
}

/**
 * Every mutation (human or AI tool) runs through the same ordered checks:
 * authorization → entitlement → feature → configuration → connector capability → AI policy → execute.
 * The guard already checked the route permission; the gate checks the *action* so services and AI tools are safe
 * even when called outside HTTP.
 */
@Injectable()
export class ActionGate {
  constructor(
    private readonly actors: ActorStore,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
    private readonly flags: FeatureFlagService,
    @InjectLogger() private readonly logger: Logger,
    @Optional()
    @Inject(ENTITLEMENT_STAGE)
    private readonly entitlement: GateStage = new PassThroughStage('entitlement'),
    @Optional()
    @Inject(CONFIGURATION_STAGE)
    private readonly configuration: GateStage = new PassThroughStage('configuration'),
    @Optional()
    @Inject(CONNECTOR_CAPABILITY_STAGE)
    private readonly connector: GateStage = new PassThroughStage('connectorCapability'),
    @Optional()
    @Inject(AI_POLICY_STAGE)
    private readonly aiPolicy: GateStage = new PassThroughStage('aiPolicy'),
    @Optional()
    @Inject(AI_AGENT_AUTHORIZER)
    private readonly agents?: AiAgentAuthorizer,
  ) {}

  async execute<T>(request: ActionRequest, handler: () => Promise<T>): Promise<T> {
    const actor = request.actor ?? this.actors.require();
    // 1. authorization (AI agents by the AI context: only what their tools need; refused without it)
    const scope = { tenantId: request.tenantId, propertyId: request.propertyId ?? null };
    const allowed =
      actor.type === 'AI_AGENT'
        ? ((await this.agents?.hasPermission(actor, request.action, scope)) ?? false)
        : await this.permissions.hasPermission(actor, request.action, scope);
    if (!allowed) throw AppError.forbidden('platform.forbidden', { permission: request.action });
    // 2. entitlement
    await this.entitlement.check(request, actor);
    // 3. feature availability
    if (request.feature) {
      const on = await this.flags.isEnabled(request.feature, {
        tenantId: request.tenantId,
        propertyId: request.propertyId ?? null,
      });
      if (!on)
        throw new AppError('platform.feature_disabled', HttpStatus.FORBIDDEN, {
          feature: request.feature,
        });
    }
    // 4. configuration, 5. connector capability, 6. AI policy
    await this.configuration.check(request, actor);
    if (request.connectorCapability) await this.connector.check(request, actor);
    if (actor.type === 'AI_AGENT') await this.aiPolicy.check(request, actor);
    this.logger.debug(
      {
        action: request.action,
        tenant_id: request.tenantId,
        property_id: request.propertyId ?? null,
        actor_id: actor.id,
      },
      'action gate passed',
    );
    return handler();
  }
}
