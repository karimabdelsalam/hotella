import { Injectable } from '@nestjs/common';
import type { ConnectorCapability } from '@hotella/contracts-connectors';
import { newId } from '@hotella/platform-database';
import { effectiveCapabilities } from './domain/instance';
import { IntegrationRepositories } from './infrastructure/repositories';
import type {
  ExternalReferenceSummary,
  IntegrationInstanceSummary,
  IntegrationsPublicApi,
  LinkReferenceInput,
} from './public';

@Injectable()
export class IntegrationsPublicApiService implements IntegrationsPublicApi {
  constructor(private readonly repo: IntegrationRepositories) {}

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
