import { Injectable } from '@nestjs/common';
import type { ConnectorCapability } from '@hotella/contracts-connectors';
import { TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  PMS_OPERATIONS,
  type PmsOperation,
  type PmsOperationDefinition,
} from '../domain/capabilities';
import type { PmsPublicApi, PmsWriteContext, PmsWriteOutcome } from '../public';
import { IntegrationsPublicApiService } from '../public-api.service';
import { CapabilityRegistry } from './capability-registry';

/**
 * `PMS_API` (ADR-0019; guide §4): business operations routed by the per-property capability registry. A write goes to
 * the first effective connector of the operation's order as one durable command, with the routing decision kept on it;
 * it is never retried on another connector (the command reports FAILED and the operator or module decides).
 */
@Injectable()
export class PmsService implements PmsPublicApi {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly commands: IntegrationsPublicApiService,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  can(tenantId: string, propertyId: string, capability: ConnectorCapability): Promise<boolean> {
    return this.tx.read(() => this.registry.can({ tenantId, propertyId }, capability));
  }

  setRoomStatus(
    input: PmsWriteContext & {
      readonly roomNumber: string;
      readonly status: 'DIRTY' | 'CLEAN' | 'INSPECTED';
      readonly occupied?: boolean;
    },
  ): Promise<PmsWriteOutcome> {
    return this.write('SET_ROOM_STATUS', input, {
      room_number: input.roomNumber,
      status: input.status,
      ...(input.occupied === undefined ? {} : { occupied: input.occupied }),
    });
  }

  setRoomRestriction(
    input: PmsWriteContext & {
      readonly roomNumber: string;
      readonly kind: 'OOO' | 'OOS' | 'BLOCKED_OPERATIONALLY';
      readonly active: boolean;
    },
  ): Promise<PmsWriteOutcome> {
    return this.write('SET_ROOM_RESTRICTION', input, {
      room_number: input.roomNumber,
      kind: input.kind,
      active: input.active,
    });
  }

  private write(
    operation: PmsOperation,
    input: PmsWriteContext,
    payload: Record<string, unknown>,
  ): Promise<PmsWriteOutcome> {
    const op: PmsOperationDefinition = PMS_OPERATIONS[operation];
    return this.tx.run(async () => {
      const facts = await this.registry.facts({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
      });
      const decision = this.registry.decide(facts, operation);
      const target = decision.route[0];
      if (!target) {
        this.logger.info(
          { operation, property_id: input.propertyId, skipped: decision.skipped.length },
          'pms operation not available at the property',
        );
        return { outcome: 'UNAVAILABLE', capability: op.capability };
      }
      const command = await this.commands.requestCommand({
        tenantId: input.tenantId,
        integrationInstanceId: target.instanceId,
        commandType: op.command!,
        payload,
        idempotencyKey: input.idempotencyKey,
        requestedBy: input.requestedBy,
        correlationId: input.correlationId ?? null,
        routing: {
          operation,
          chosen: target.connectorCode,
          route: decision.route.map((r) => r.connectorCode),
          skipped: decision.skipped,
        },
      });
      return {
        outcome: 'QUEUED',
        commandId: command.id,
        connectorCode: target.connectorCode,
        status: command.status,
      };
    });
  }
}
