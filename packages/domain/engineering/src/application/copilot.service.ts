import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  type ClassifiedText,
  STAFF_ASSISTANT_API,
  type StaffAssistantApi,
} from '@hotella/domain-ai/public';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { EngineeringRepositories } from '../infrastructure/repositories';

export const askCopilotSchema = z.object({
  question: z.string().trim().min(2).max(1000),
  /** The asset the engineer has open, if any. */
  assetId: z.uuid().optional(),
});

/**
 * The Engineering Copilot v1 for staff (BUILD_PLAN 8.B, ASSIST): the person must be allowed to read engineering work
 * and assets at the property; the copilot then only reads (its tools are READ) and answers. The asset the engineer is
 * looking at is given to it as focus.
 */
@Injectable()
export class CopilotService {
  constructor(
    private readonly repo: EngineeringRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
    @Optional() @Inject(STAFF_ASSISTANT_API) private readonly assistant?: StaffAssistantApi,
  ) {}

  async ask(scope: PropertyScope, input: z.infer<typeof askCopilotSchema>) {
    const at = { tenantId: scope.tenantId, propertyId: scope.propertyId };
    // What the copilot can read, the person must be able to read too.
    await this.gate.execute({ action: 'eng.asset.read', ...at }, async () => undefined);
    return this.gate.execute({ action: 'eng.work_order.read', ...at }, async () => {
      if (!this.assistant) throw new AppError('platform.not_ready', HttpStatus.SERVICE_UNAVAILABLE);
      const focus: ClassifiedText[] = [];
      if (input.assetId) {
        const asset = await this.tx.read(() =>
          isUuid(input.assetId!)
            ? this.repo.asset(scope, input.assetId!)
            : Promise.resolve(undefined),
        );
        if (!asset || asset.propertyId !== scope.propertyId)
          throw AppError.notFound('eng.asset.not_found');
        focus.push({
          text: `The engineer has this asset open: ${asset.assetNumber} "${asset.name}" (asset_id ${asset.id}).`,
          dataClass: 'INTERNAL',
        });
      }
      const actor = this.actors.require();
      return this.assistant.ask({
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        agentCode: 'ENGINEERING_COPILOT',
        question: input.question,
        locale: this.locale.get(),
        userId: actor.id,
        focus,
      });
    });
  }
}
