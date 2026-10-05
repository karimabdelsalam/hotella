import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { inboundBatchSchema, transportsOf } from '@hotella/contracts-connectors';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { ConnectorRegistry } from '../connectors/registry';
import { deriveInboundSecret, verifySignature } from '../domain/webhooks';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { InboundEndpointRow } from '../infrastructure/schema';
import { WebhookRepositories } from '../infrastructure/webhook-repositories';
import { IngestService } from './ingest.service';
import { WebhookKeys } from './webhook.service';

export const rotateInboundSchema = z.object({ version: z.number().int().min(1) });

const present = (e: InboundEndpointRow) => ({
  id: e.id,
  instanceId: e.instanceId,
  status: e.status,
  secretVersion: e.secretVersion,
  lastUsedAt: e.lastUsedAt,
  path: `/integrations/inbound/${e.id}`,
  createdAt: e.createdAt,
  version: e.version,
});

/**
 * Signed webhook ingress for cloud-hosted vendor systems (ADR-0024, Connector SDK v2): an integration instance whose
 * connector accepts the `WEBHOOK` transport gets endpoints; each request is a batch of raw messages signed with the
 * endpoint's secret (shown once, never stored) and goes through the same ingest → map → canonical event pipeline as
 * the agent link, idempotent on `source_message_id`.
 */
@Injectable()
export class InboundEndpointService {
  constructor(
    private readonly repo: WebhookRepositories,
    private readonly integrations: IntegrationRepositories,
    private readonly registry: ConnectorRegistry,
    private readonly keys: WebhookKeys,
    private readonly ingest: IngestService,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  private async secret(
    endpoint: Pick<InboundEndpointRow, 'id' | 'secretVersion'>,
  ): Promise<string> {
    const key = await this.keys.signingKey();
    if (!key) throw new AppError('integration.webhook.unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    return deriveInboundSecret(key, endpoint.id, endpoint.secretVersion);
  }

  private async instanceAt(scope: PropertyScope, instanceId: string) {
    const instance = isUuid(instanceId)
      ? await this.integrations.instance(scope, instanceId)
      : undefined;
    if (!instance || instance.propertyId !== scope.propertyId)
      throw AppError.notFound('integration.instance.not_found');
    return instance;
  }

  list(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.instanceAt(scope, instanceId);
          return (await this.repo.inboundOfInstance(scope, instanceId)).map(present);
        }),
    );
  }

  create(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.configure', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const instance = await this.instanceAt(scope, instanceId);
          const manifest = this.registry.get(instance.connectorCode)?.manifest;
          if (!manifest || !transportsOf(manifest).includes('WEBHOOK'))
            throw AppError.conflict('integration.inbound.not_supported', {
              connector: instance.connectorCode,
            });
          const id = newId();
          // Resolve the secret first: no endpoint is created that could never be verified.
          const secret = await this.secret({ id, secretVersion: 1 });
          const actor = this.actors.require();
          const row = await this.repo.insertInbound({
            id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            instanceId: instance.id,
            createdBy: isUuid(actor.id) ? actor.id : null,
          });
          await this.audit.record({
            action: 'integration.inbound.create',
            entityType: 'inbound_endpoint',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { instance_id: instance.id, status: row.status },
          });
          return { endpoint: present(row), secret };
        }),
    );
  }

  rotate(scope: PropertyScope, instanceId: string, endpointId: string, version: number) {
    return this.change(scope, instanceId, endpointId, version, 'rotate');
  }

  revoke(scope: PropertyScope, instanceId: string, endpointId: string, version: number) {
    return this.change(scope, instanceId, endpointId, version, 'revoke');
  }

  private change(
    scope: PropertyScope,
    instanceId: string,
    endpointId: string,
    version: number,
    what: 'rotate' | 'revoke',
  ) {
    return this.gate.execute(
      { action: 'integration.configure', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          await this.instanceAt(scope, instanceId);
          const endpoint = isUuid(endpointId)
            ? await this.repo.inbound(scope, endpointId)
            : undefined;
          if (!endpoint || endpoint.instanceId !== instanceId)
            throw AppError.notFound('integration.inbound.not_found');
          if (endpoint.status !== 'ACTIVE') throw AppError.conflict('integration.inbound.revoked');
          const row = await this.repo.updateInbound(
            endpoint.id,
            version,
            what === 'rotate'
              ? { secretVersion: endpoint.secretVersion + 1 }
              : { status: 'REVOKED' },
          );
          if (!row) throw AppError.conflict('integration.inbound.version_conflict');
          await this.audit.record({
            action: `integration.inbound.${what}`,
            entityType: 'inbound_endpoint',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: { status: endpoint.status, secret_version: endpoint.secretVersion },
            after: { status: row.status, secret_version: row.secretVersion },
          });
          return what === 'rotate'
            ? { endpoint: present(row), secret: await this.secret(row) }
            : { endpoint: present(row) };
        }),
    );
  }

  /**
   * The public ingress: an unknown, revoked or wrongly signed request learns nothing (401 for every signature
   * problem, 404 only for an endpoint that does not exist or is revoked). Each message is ingested on its own.
   */
  async receive(
    endpointId: string,
    body: Buffer | undefined,
    signature: string | undefined,
    now = new Date(),
  ) {
    const endpoint = isUuid(endpointId)
      ? await this.tx.read(() => this.repo.inboundUnscoped(endpointId))
      : undefined;
    if (!endpoint || endpoint.status !== 'ACTIVE')
      throw AppError.notFound('integration.inbound.not_found');
    if (!body)
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
    const verdict = verifySignature(await this.secret(endpoint), signature, body, now);
    if (verdict !== 'OK') {
      this.logger.warn({ endpoint_id: endpoint.id, verdict }, 'inbound webhook refused');
      throw new AppError('integration.inbound.bad_signature', HttpStatus.UNAUTHORIZED);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
    }
    const batch = inboundBatchSchema.safeParse(parsed);
    if (!batch.success)
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, {
        count: batch.error.issues.length,
      });
    const results = [];
    for (const message of batch.data.messages) {
      const result = await this.ingest.ingest(endpoint.instanceId, message);
      results.push({
        source_message_id: message.source_message_id,
        outcome: result.outcome,
        status: result.status,
      });
    }
    await this.tx.run(() => this.repo.touchInbound(endpoint.id, now));
    return { results };
  }
}
