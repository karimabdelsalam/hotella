import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { CurrentLocale } from '@hotella/platform-i18n';
import { MANAGER_ASSIST } from '../domain/agents';
import { PulseService } from './pulse.service';
import { StaffAssistantRuntime } from './staff-assistant.runtime';
import { IntelligenceTools } from './tools/intelligence';

export const askManagerSchema = z.object({ question: z.string().trim().min(2).max(1000) });

/**
 * The Manager assistant for people (BUILD_PLAN 12.5): `ai.manager.use` at the property and the AI_INTELLIGENCE
 * entitlement; the assistant then reads through its READ tools only and answers. The cross-property comparison is a
 * tenant-level report (`ai.intelligence.cross_property`).
 */
@Injectable()
export class ManagerService {
  constructor(
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
    private readonly assistant: StaffAssistantRuntime,
    private readonly tools: IntelligenceTools,
    private readonly pulses: PulseService,
  ) {}

  ask(scope: PropertyScope, input: z.infer<typeof askManagerSchema>) {
    return this.gate.execute(
      {
        action: 'ai.manager.use',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        entitlement: 'AI_INTELLIGENCE',
      },
      () =>
        this.assistant.ask({
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          agentCode: MANAGER_ASSIST.code,
          question: input.question,
          locale: this.locale.get(),
          userId: this.actors.require().id,
        }),
    );
  }

  /** The property's live counts (the Intelligence screen; the same numbers the assistant reads). */
  pulse(scope: PropertyScope) {
    return this.gate.execute(
      {
        action: 'ai.insight.read',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        entitlement: 'AI_INTELLIGENCE',
      },
      () => this.pulses.pulse(scope),
    );
  }

  compare(tenantId: string) {
    return this.gate.execute(
      { action: 'ai.intelligence.cross_property', tenantId, propertyId: null },
      async () => ({ properties: await this.tools.comparison(tenantId) }),
    );
  }
}
