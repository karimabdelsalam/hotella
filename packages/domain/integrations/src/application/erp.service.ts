import { HttpStatus, Injectable } from '@nestjs/common';
import { RequisitionSettled } from '@hotella/contracts-events';
import { type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { erpStockRowSchema, requisitionPayloadSchema } from '../connectors/erp';
import { effectiveCapabilities } from '../domain/instance';
import { LinkRepositories } from '../infrastructure/link-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type {
  ErpCapability,
  ErpPublicApi,
  ErpRequisitionInput,
  ErpRequisitionOutcome,
  ErpStockOutcome,
} from '../public';
import { IntegrationsPublicApiService } from '../public-api.service';
import { AgentQueryService } from './agent-query.service';

/** The part side of the reference; the ERP side is the item code. */
export const PART_ENTITY = 'eng.part';
export const ERP_ITEM = 'ERP_ITEM';
/** A requisition that waits longer than this for the hotel agent is not sent any more (engineering asks again). */
const REQUISITION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ERP behind `ERP_API` (BUILD_PLAN 13.5): stock reads and requisitions through the property's `ERP_STANDARD` (or
 * vendor) connector. A part's ERP item code is an external reference (rule 3) linked by staff; engineering only ever
 * names its parts. Requisitions are commands the caller had approved by a person.
 */
@Injectable()
export class ErpService implements ErpPublicApi {
  constructor(
    private readonly integrations: IntegrationRepositories,
    private readonly links: LinkRepositories,
    private readonly references: IntegrationsPublicApiService,
    private readonly queries: AgentQueryService,
    private readonly events: EventPublisher,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async available(tenantId: string, propertyId: string, capability: ErpCapability) {
    return (await this.route({ tenantId }, propertyId, capability)) !== undefined;
  }

  async linkItem(input: {
    tenantId: string;
    propertyId: string;
    partId: string;
    itemCode: string;
  }): Promise<void> {
    const scope = { tenantId: input.tenantId };
    const instance =
      (await this.route(scope, input.propertyId, 'STOCK_READ')) ??
      (await this.route(scope, input.propertyId, 'REQUISITION_CREATE'));
    if (!instance) throw new AppError('integration.erp.unavailable', HttpStatus.CONFLICT);
    const itemCode = input.itemCode.trim();
    if ((await this.itemOf(input.tenantId, input.partId)) === itemCode) return;
    await this.references.unlinkExternalIdentity(input.tenantId, PART_ENTITY, input.partId);
    const holder = await this.references.linkReference({
      tenantId: input.tenantId,
      integrationInstanceId: instance.id,
      internalEntityType: PART_ENTITY,
      internalEntityId: input.partId,
      externalEntityType: ERP_ITEM,
      externalId: itemCode,
    });
    if (holder !== input.partId) throw AppError.conflict('integration.erp.item_taken');
  }

  async itemOf(tenantId: string, partId: string): Promise<string | null> {
    const refs = await this.references.referencesFor(tenantId, PART_ENTITY, partId);
    return refs.find((r) => r.externalEntityType === ERP_ITEM)?.externalId ?? null;
  }

  /** Waits for the agent: call it outside any transaction. */
  async stock(input: {
    tenantId: string;
    propertyId: string;
    partIds: readonly string[];
    requestedBy: { type: string; id: string | null };
  }): Promise<ErpStockOutcome> {
    const scope = { tenantId: input.tenantId };
    const { instance, items } = await this.tx.read(async () => {
      const items = new Map<string, string>();
      for (const partId of input.partIds) {
        const code = await this.itemOf(input.tenantId, partId);
        if (code) items.set(code, partId);
      }
      return { instance: await this.route(scope, input.propertyId, 'STOCK_READ'), items };
    });
    const unlinked = input.partIds.filter((id) => ![...items.values()].includes(id));
    if (!instance) return { outcome: 'UNAVAILABLE', unlinked };
    if (items.size === 0) return { outcome: 'OK', levels: [], unlinked };
    const answer = await this.queries.run({
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      instanceId: instance.id,
      connectorCode: instance.connectorCode,
      queryType: 'ERP_STOCK',
      params: { items: [...items.keys()] },
      requestedBy: input.requestedBy,
    });
    if (answer.status !== 'OK') {
      this.logger.warn(
        { instance_id: instance.id, status: answer.status },
        'erp stock read failed',
      );
      return { outcome: 'FAILED', reason: answer.status, unlinked };
    }
    const levels = answer.rows
      .map((r) => erpStockRowSchema.parse(r))
      .filter((r) => items.has(r.item_code))
      .map((r) => ({
        partId: items.get(r.item_code)!,
        onHand: r.on_hand,
        unit: r.unit,
        warehouse: r.warehouse,
      }));
    return { outcome: 'OK', levels, unlinked };
  }

  /** Joins the caller's transaction (the approval that allowed it). */
  async requestRequisition(input: ErpRequisitionInput): Promise<ErpRequisitionOutcome> {
    const scope = { tenantId: input.tenantId };
    const instance = await this.route(scope, input.propertyId, 'REQUISITION_CREATE');
    if (!instance) return { status: 'UNAVAILABLE', reason: 'NO_CONNECTOR' };
    const lines = [];
    for (const line of input.lines) {
      const code = await this.itemOf(input.tenantId, line.partId);
      if (!code) return { status: 'UNAVAILABLE', reason: 'UNLINKED_ITEM' };
      lines.push({ item_code: code, quantity: line.quantity, unit: line.unit });
    }
    const command = await this.references.requestCommand({
      tenantId: input.tenantId,
      integrationInstanceId: instance.id,
      commandType: 'REQUISITION_CREATE',
      payload: requisitionPayloadSchema.parse({
        requisition_ref: input.requisitionId,
        lines,
        needed_by: input.neededBy,
      }),
      idempotencyKey: `requisition:${input.requisitionId}`,
      expiresAt: new Date(Date.now() + REQUISITION_TTL_MS),
      requestedBy: input.requestedBy,
    });
    return { status: 'SENT', commandId: command.id };
  }

  /** The agent link hands every command result and expiry here; requisitions are announced to their owner. */
  async onCommandResult(
    scope: TenantScope,
    commandId: string,
    status: 'ACKNOWLEDGED' | 'FAILED' | 'EXPIRED',
    error: string | null,
  ): Promise<void> {
    const command = await this.links.command(scope, commandId);
    if (!command || command.commandType !== 'REQUISITION_CREATE') return;
    const payload = requisitionPayloadSchema.safeParse(command.payload);
    if (!payload.success) return;
    await this.events.publish(RequisitionSettled, {
      tenantId: command.tenantId,
      propertyId: command.propertyId,
      source: 'integration',
      aggregate: { type: 'integration_command', id: command.id },
      payload: {
        requisition_id: payload.data.requisition_ref,
        command_id: command.id,
        status,
        error: error ? error.slice(0, 200) : null,
      },
    });
  }

  private async route(scope: TenantScope, propertyId: string, capability: ErpCapability) {
    return (await this.integrations.listInstances({ ...scope, propertyId }))
      .filter((i) => effectiveCapabilities(i).includes(capability))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
  }
}
