import { HttpStatus, Injectable } from '@nestjs/common';
import { ReconciliationCompleted } from '@hotella/contracts-events';
import { EventPublisher } from '@hotella/platform-events';
import type { ConnectorCapability } from '@hotella/contracts-connectors';
import { newId } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { CapabilityRegistry } from './application/capability-registry';
import { ConnectorRegistry } from './connectors/registry';
import { effectiveCapabilities } from './domain/instance';
import { LinkRepositories } from './infrastructure/link-repositories';
import { ReconciliationRepositories } from './infrastructure/reconciliation-repositories';
import { IntegrationRepositories } from './infrastructure/repositories';
import type { IntegrationCommandRow } from './infrastructure/schema';
import type {
  ReconciliationFinding,
  ReconciliationSnapshot,
  CommandRequest,
  CommandSummary,
  ExternalReferenceSummary,
  IntegrationInstanceSummary,
  IntegrationsPublicApi,
  LinkReferenceInput,
} from './public';

@Injectable()
export class IntegrationsPublicApiService implements IntegrationsPublicApi {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly links: LinkRepositories,
    private readonly connectors: ConnectorRegistry,
    private readonly reconciliation: ReconciliationRepositories,
    private readonly events: EventPublisher,
    private readonly capabilities: CapabilityRegistry,
  ) {}

  unlinkExternalIdentity(
    tenantId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<number> {
    return this.repo.deleteReferences({ tenantId }, internalEntityType, internalEntityId);
  }

  scrubRawMessages(
    tenantId: string,
    integrationInstanceId: string,
    reservationExternalIds: readonly string[],
  ): Promise<number> {
    return this.repo.scrubMessages(
      { tenantId },
      integrationInstanceId,
      reservationExternalIds.map((id) => `reservation:${id}`),
    );
  }

  async reconciliationSnapshot(
    tenantId: string,
    runId: string,
  ): Promise<ReconciliationSnapshot | null> {
    const run = await this.reconciliation.run({ tenantId }, runId);
    if (!run) return null;
    const entries = await this.reconciliation.entries({ tenantId }, runId);
    return {
      runId: run.id,
      integrationInstanceId: run.instanceId,
      familyInstanceIds: await this.familyInstanceIds(tenantId, run.instanceId),
      propertyId: run.propertyId,
      status: run.status,
      entries: entries.map((e) => ({
        externalId: e.externalId,
        roomId: e.roomId,
        roomCode: e.roomCode,
      })),
    };
  }

  async completeReconciliation(
    tenantId: string,
    runId: string,
    findings: readonly ReconciliationFinding[],
  ): Promise<void> {
    const scope = { tenantId };
    const run = await this.reconciliation.runForUpdate(scope, runId);
    if (!run || run.status !== 'RUNNING') return;
    await this.reconciliation.insertResults(
      findings.map((f) => ({
        id: newId(),
        tenantId,
        runId,
        entityType: f.entityType,
        outcome: f.outcome,
        externalId: f.externalId,
        internalId: f.internalId,
        details: f.details,
      })),
    );
    for (const f of findings.filter((x) => x.outcome !== 'MATCH'))
      await this.repo.insertException({
        id: newId(),
        tenantId,
        propertyId: run.propertyId,
        instanceId: run.instanceId,
        kind: 'CONFLICT',
        detail: {
          reason: 'reconciliation',
          run_id: runId,
          outcome: f.outcome,
          external_id: f.externalId,
          internal_id: f.internalId,
          ...f.details,
        },
      });
    const summary: Record<string, number> = {
      MATCH: 0,
      MISSING_INTERNAL: 0,
      MISSING_EXTERNAL: 0,
      DIFFERENT: 0,
    };
    for (const f of findings) summary[f.outcome] = (summary[f.outcome] ?? 0) + 1;
    await this.reconciliation.updateRun(scope, runId, {
      status: 'COMPLETED',
      completedAt: new Date(),
      summary,
    });
    await this.events.publish(ReconciliationCompleted, {
      tenantId,
      propertyId: run.propertyId,
      source: 'integration',
      aggregate: { type: 'reconciliation_run', id: runId },
      payload: { run_id: runId, instance_id: run.instanceId, summary },
    });
  }

  async requestCommand(input: CommandRequest): Promise<CommandSummary> {
    const scope = { tenantId: input.tenantId };
    const instance = await this.repo.instance(scope, input.integrationInstanceId);
    if (!instance) throw AppError.notFound('integration.instance.not_found');
    const existing = await this.repo.commandByKey(scope, instance.id, input.idempotencyKey);
    if (existing) return toCommandSummary(existing);
    const command = this.connectors
      .get(instance.connectorCode)
      ?.manifest.commands.find((c) => c.code === input.commandType);
    if (!command)
      throw new AppError('integration.command.unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
        command: input.commandType,
      });
    if (!effectiveCapabilities(instance).includes(command.requires))
      throw new AppError('integration.capability_unavailable', HttpStatus.CONFLICT, {
        capability: command.requires,
      });
    const payload = command.payload.safeParse(input.payload);
    if (!payload.success)
      throw new AppError('integration.command.invalid_payload', HttpStatus.UNPROCESSABLE_ENTITY);
    const row =
      (await this.repo.insertCommand({
        id: newId(),
        tenantId: instance.tenantId,
        propertyId: instance.propertyId,
        instanceId: instance.id,
        commandType: command.code,
        payload: payload.data ?? {},
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt ?? null,
        correlationId: input.correlationId ?? null,
        requestedByType: input.requestedBy.type,
        requestedById: input.requestedBy.id,
        routing: input.routing ?? null,
      })) ?? (await this.repo.commandByKey(scope, instance.id, input.idempotencyKey))!;
    return toCommandSummary(row);
  }

  async getCommand(tenantId: string, commandId: string): Promise<CommandSummary | null> {
    const row = await this.links.command({ tenantId }, commandId);
    return row ? toCommandSummary(row) : null;
  }

  /**
   * The instances whose external ids are one namespace with this one: the same connector family (e.g. OPERA5) at the
   * same property — this instance first. A connector without a family is its own namespace.
   */
  async familyInstanceIds(tenantId: string, integrationInstanceId: string): Promise<string[]> {
    const instance = await this.repo.instance({ tenantId }, integrationInstanceId);
    if (!instance) return [integrationInstanceId];
    const family = this.connectors.get(instance.connectorCode)?.manifest.family;
    if (!family) return [instance.id];
    const siblings = (
      await this.repo.listInstances({ tenantId, propertyId: instance.propertyId })
    ).filter(
      (i) =>
        i.id !== instance.id && this.connectors.get(i.connectorCode)?.manifest.family === family,
    );
    return [instance.id, ...siblings.map((i) => i.id)];
  }

  async resolveReference(
    tenantId: string,
    integrationInstanceId: string,
    externalEntityType: string,
    externalId: string,
  ): Promise<string | null> {
    const own = await this.repo.externalReference(
      { tenantId },
      integrationInstanceId,
      externalEntityType,
      externalId,
    );
    if (own) return own.internalEntityId;
    // Another connector of the same PMS may know it already (a reservation from OWS, now checked in through FIAS).
    const family = await this.familyInstanceIds(tenantId, integrationInstanceId);
    if (family.length === 1) return null;
    const shared = await this.repo.externalReferenceAmong(
      { tenantId },
      family,
      externalEntityType,
      externalId,
    );
    return shared?.internalEntityId ?? null;
  }

  async linkReference(input: LinkReferenceInput): Promise<string> {
    // The family's first holder wins, as within one instance: this instance then points at the same internal entity.
    const family = await this.familyInstanceIds(input.tenantId, input.integrationInstanceId);
    const shared =
      family.length > 1
        ? await this.repo.externalReferenceAmong(
            { tenantId: input.tenantId },
            family,
            input.externalEntityType,
            input.externalId,
          )
        : undefined;
    const row = await this.repo.linkReference({
      id: newId(),
      tenantId: input.tenantId,
      integrationInstanceId: input.integrationInstanceId,
      internalEntityType: input.internalEntityType,
      internalEntityId: shared?.internalEntityId ?? input.internalEntityId,
      externalEntityType: input.externalEntityType,
      externalId: input.externalId,
    });
    return row.internalEntityId;
  }

  async referencesFor(
    tenantId: string,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<readonly ExternalReferenceSummary[]> {
    return (
      await this.repo.referencesForInternal({ tenantId }, internalEntityType, internalEntityId)
    ).map((r) => ({
      integrationInstanceId: r.integrationInstanceId,
      internalEntityType: r.internalEntityType,
      internalEntityId: r.internalEntityId,
      externalEntityType: r.externalEntityType,
      externalId: r.externalId,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  repointReferences(
    tenantId: string,
    internalEntityType: string,
    fromId: string,
    toId: string,
  ): Promise<number> {
    return this.repo.repointReferences({ tenantId }, internalEntityType, fromId, toId);
  }

  /** The registry's verdict (verification, licence and health included), not just the instance's enablement. */
  hasCapability(
    tenantId: string,
    propertyId: string,
    capability: ConnectorCapability,
  ): Promise<boolean> {
    return this.capabilities.can({ tenantId, propertyId }, capability);
  }

  async listInstances(
    tenantId: string,
    propertyId: string,
  ): Promise<readonly IntegrationInstanceSummary[]> {
    return (await this.repo.listInstances({ tenantId, propertyId })).map((i) => ({
      id: i.id,
      propertyId: i.propertyId,
      connectorCode: i.connectorCode,
      name: i.name,
      status: i.status,
      effectiveCapabilities: effectiveCapabilities(i),
    }));
  }
}

function toCommandSummary(c: IntegrationCommandRow): CommandSummary {
  return {
    id: c.id,
    integrationInstanceId: c.instanceId,
    commandType: c.commandType,
    status: c.status,
    attempts: c.attempts,
    error: c.error,
    createdAt: c.createdAt,
    acknowledgedAt: c.acknowledgedAt,
  };
}
