import { Injectable } from '@nestjs/common';
import type { ConnectorCapability } from '@hotella/contracts-connectors';
import { TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  PMS_OPERATIONS,
  type PmsOperation,
  type PmsOperationDefinition,
} from '../domain/capabilities';
import type { PmsProfileRow, PmsReservationRow, PmsRoomRow } from '@hotella/contracts-connectors';
import type {
  PmsPublicApi,
  PmsReadContext,
  PmsReadOutcome,
  PmsWriteContext,
  PmsWriteOutcome,
} from '../public';
import { AgentQueryService } from './agent-query.service';
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
    private readonly agentQueries: AgentQueryService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  lookupReservation(
    input: PmsReadContext &
      ({ readonly confirmationNumber: string } | { readonly reservationId: string }),
  ): Promise<PmsReadOutcome<PmsReservationRow>> {
    return this.read(
      'LOOKUP_RESERVATION',
      input,
      'confirmationNumber' in input
        ? { confirmation_number: input.confirmationNumber }
        : { reservation_id: input.reservationId },
    );
  }

  listArrivals(
    input: PmsReadContext & { readonly from: string; readonly to: string },
  ): Promise<PmsReadOutcome<PmsReservationRow>> {
    return this.read('LIST_ARRIVALS', input, { from: input.from, to: input.to });
  }

  inHouseSnapshot(input: PmsReadContext): Promise<PmsReadOutcome<PmsReservationRow>> {
    return this.read('IN_HOUSE_SNAPSHOT', input, {});
  }

  lookupProfile(
    input: PmsReadContext & { readonly profileId: string },
  ): Promise<PmsReadOutcome<PmsProfileRow>> {
    return this.read('LOOKUP_PROFILE', input, { profile_id: input.profileId });
  }

  roomInventory(input: PmsReadContext): Promise<PmsReadOutcome<PmsRoomRow>> {
    return this.read('ROOM_INVENTORY', input, {});
  }

  /**
   * Guide §4.3 for reads: the effective connectors in order; one that is unreachable, too slow or fails gives way to
   * the next, and every attempt is on record (`integration_queries`). Runs outside any transaction (it waits).
   */
  async read<R>(
    operation: PmsOperation,
    input: PmsReadContext,
    params: Record<string, unknown>,
  ): Promise<PmsReadOutcome<R>> {
    const op: PmsOperationDefinition = PMS_OPERATIONS[operation];
    const decision = await this.tx.read(async () =>
      this.registry.decide(
        await this.registry.facts({ tenantId: input.tenantId, propertyId: input.propertyId }),
        operation,
      ),
    );
    const attempts: Array<{ connectorCode: string; status: string }> = [];
    for (const target of decision.route) {
      if (!this.registry.servesQuery(target.connectorCode, op.query!)) {
        attempts.push({ connectorCode: target.connectorCode, status: 'NO_QUERY' });
        continue;
      }
      const outcome = await this.agentQueries.run({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        instanceId: target.instanceId,
        connectorCode: target.connectorCode,
        queryType: op.query!,
        params,
        deadlineMs: input.deadlineMs,
        requestedBy: input.requestedBy,
        correlationId: input.correlationId ?? null,
        routing: {
          operation,
          chosen: target.connectorCode,
          route: decision.route.map((r) => r.connectorCode),
          attempt: attempts.length + 1,
        },
      });
      if (outcome.status === 'OK')
        return {
          outcome: 'OK',
          connectorCode: target.connectorCode,
          rows: outcome.rows as R[],
          truncated: outcome.truncated,
        };
      attempts.push({ connectorCode: target.connectorCode, status: outcome.status });
    }
    if (attempts.length === 0 || attempts.every((a) => a.status === 'NO_QUERY'))
      return { outcome: 'UNAVAILABLE', capability: op.capability };
    this.logger.warn(
      { operation, property_id: input.propertyId, attempts },
      'pms read failed on every connector',
    );
    return { outcome: 'FAILED', capability: op.capability, attempts };
  }

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
