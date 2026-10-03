import { HttpStatus, Injectable } from '@nestjs/common';
import type { ConnectorCapability } from '@hotella/contracts-connectors';
import { newId } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { ConnectorRegistry } from './connectors/registry';
import { effectiveCapabilities } from './domain/instance';
import { LinkRepositories } from './infrastructure/link-repositories';
import { IntegrationRepositories } from './infrastructure/repositories';
import type { IntegrationCommandRow } from './infrastructure/schema';
import type {
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
  ) {}

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
      })) ?? (await this.repo.commandByKey(scope, instance.id, input.idempotencyKey))!;
    return toCommandSummary(row);
  }

  async getCommand(tenantId: string, commandId: string): Promise<CommandSummary | null> {
    const row = await this.links.command({ tenantId }, commandId);
    return row ? toCommandSummary(row) : null;
  }

  async resolveReference(
    tenantId: string,
    integrationInstanceId: string,
    externalEntityType: string,
    externalId: string,
  ): Promise<string | null> {
    const ref = await this.repo.externalReference(
      { tenantId },
      integrationInstanceId,
      externalEntityType,
      externalId,
    );
    return ref?.internalEntityId ?? null;
  }

  async linkReference(input: LinkReferenceInput): Promise<string> {
    const row = await this.repo.linkReference({
      id: newId(),
      tenantId: input.tenantId,
      integrationInstanceId: input.integrationInstanceId,
      internalEntityType: input.internalEntityType,
      internalEntityId: input.internalEntityId,
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

  async hasCapability(
    tenantId: string,
    propertyId: string,
    capability: ConnectorCapability,
  ): Promise<boolean> {
    const instances = await this.repo.listInstances({ tenantId, propertyId });
    return instances.some((i) => effectiveCapabilities(i).includes(capability));
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
