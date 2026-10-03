import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { isConnectorCapability } from '@hotella/contracts-connectors';
import type { ActionRequest, GateStage } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '../public';

/**
 * Action-gate stage 5 (Spec §60, §47): an action that needs a connector capability runs only when an active
 * integration of the property currently serves it. UI and AI tools ask the same question before offering the action.
 */
@Injectable()
export class ConnectorCapabilityStage implements GateStage {
  readonly name = 'connectorCapability';
  constructor(@Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi) {}

  async check(request: ActionRequest): Promise<void> {
    const capability = request.connectorCapability;
    if (!capability) return;
    const available =
      isConnectorCapability(capability) &&
      Boolean(request.tenantId && request.propertyId) &&
      (await this.integrations.hasCapability(request.tenantId!, request.propertyId!, capability));
    if (!available)
      throw new AppError('integration.capability_unavailable', HttpStatus.CONFLICT, { capability });
  }
}
