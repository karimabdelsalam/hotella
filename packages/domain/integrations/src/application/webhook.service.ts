import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AuditWriter } from '@hotella/platform-audit';
import {
  ActionGate,
  ActorStore,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
} from '@hotella/platform-auth';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { SecretResolver } from '@hotella/platform-secrets';
import { deriveSecret, targetProblem, WEBHOOK_EVENTS } from '../domain/webhooks';
import { WebhookRepositories } from '../infrastructure/webhook-repositories';
import type { WebhookDeliveryRow, WebhookEndpointRow } from '../infrastructure/schema';

const eventTypes = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .transform((a) => [...new Set(a)].sort());

export const createWebhookSchema = z.object({
  url: z.string().trim().max(2000),
  eventTypes,
  propertyId: z.uuid().nullish(),
  description: z.string().trim().max(500).nullish(),
});
export const updateWebhookSchema = z.object({
  version: z.number().int().min(1),
  url: z.string().trim().max(2000).optional(),
  eventTypes: eventTypes.optional(),
  description: z.string().trim().max(500).nullish(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
});
export const webhookDeliveriesQuerySchema = z.object({
  status: z.enum(['PENDING', 'DELIVERED', 'DEAD']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
export type WebhookDeliveriesQuery = z.infer<typeof webhookDeliveriesQuerySchema>;

const ACTION = 'integration.webhook.manage';
const ENTITLEMENT = 'API_ACCESS';

/**
 * The platform key endpoint secrets derive from (a SecretRef, CLAUDE.md rule 13). Without it webhooks are unavailable:
 * a secret shown to a tenant must verify in every process, so there is no ephemeral fallback.
 */
@Injectable()
export class WebhookKeys {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Explicit token: see AgentKeys.
    @Optional() @Inject(SecretResolver) private readonly secrets: SecretResolver | null,
  ) {}

  async signingKey(): Promise<string | null> {
    const ref = this.config.webhooks.signingKeyRef;
    if (!ref || !this.secrets) return null;
    return this.secrets.resolve(ref);
  }

  async secretFor(endpoint: Pick<WebhookEndpointRow, 'id' | 'secretVersion'>): Promise<string> {
    const key = await this.signingKey();
    if (!key) throw new AppError('integration.webhook.unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    return deriveSecret(key, endpoint.id, endpoint.secretVersion);
  }
}

/**
 * Developer platform v1 (Spec §75, BUILD_PLAN 11.5): a tenant's outbound webhook endpoints, their deliveries and
 * replay. Every action needs `integration.webhook.manage` and the API_ACCESS entitlement; the signing secret is shown
 * only at creation and rotation.
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly repo: WebhookRepositories,
    private readonly keys: WebhookKeys,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(PROPERTY_SCOPE_VERIFIER)
    private readonly properties?: PropertyScopeVerifier | null,
  ) {}

  list(scope: TenantScope) {
    return this.gate.execute(
      { action: ACTION, tenantId: scope.tenantId, entitlement: ENTITLEMENT },
      () => this.tx.read(async () => (await this.repo.endpoints(scope)).map(presentEndpoint)),
    );
  }

  create(scope: TenantScope, input: CreateWebhookInput) {
    const propertyId = input.propertyId ?? null;
    return this.gate.execute(
      { action: ACTION, tenantId: scope.tenantId, propertyId, entitlement: ENTITLEMENT },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          this.assertTarget(input.url);
          if (
            propertyId &&
            this.properties &&
            !(await this.properties.propertyBelongsToTenant(propertyId, scope.tenantId))
          )
            throw AppError.notFound('org.property.not_found');
          const id = newId();
          // Resolve the secret first: no endpoint is created that could never be signed.
          const secret = await this.keys.secretFor({ id, secretVersion: 1 });
          const row = await this.repo.insertEndpoint({
            id,
            tenantId: scope.tenantId,
            propertyId,
            url: input.url,
            eventTypes: input.eventTypes,
            description: input.description ?? null,
            createdBy: isUuid(actor.id) ? actor.id : null,
          });
          await this.audit.record({
            action: 'integration.webhook.create',
            entityType: 'webhook_endpoint',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId,
            after: { event_types: row.eventTypes, status: row.status },
          });
          return { endpoint: presentEndpoint(row), secret };
        }),
    );
  }

  update(scope: TenantScope, id: string, input: UpdateWebhookInput) {
    return this.gate.execute(
      { action: ACTION, tenantId: scope.tenantId, entitlement: ENTITLEMENT },
      () =>
        this.tx.run(async () => {
          const current = await this.load(scope, id);
          if (input.url !== undefined) this.assertTarget(input.url);
          const row = await this.repo.updateEndpoint(scope, id, input.version, {
            ...(input.url !== undefined && { url: input.url }),
            ...(input.eventTypes !== undefined && { eventTypes: input.eventTypes }),
            ...(input.description !== undefined && { description: input.description ?? null }),
            ...(input.status !== undefined && { status: input.status }),
          });
          if (!row) throw AppError.conflict('integration.webhook.version_conflict');
          await this.audit.record({
            action: 'integration.webhook.update',
            entityType: 'webhook_endpoint',
            entityId: id,
            tenantId: scope.tenantId,
            propertyId: row.propertyId,
            before: { event_types: current.eventTypes, status: current.status },
            after: {
              event_types: row.eventTypes,
              status: row.status,
              url_changed: input.url !== undefined,
            },
          });
          return presentEndpoint(row);
        }),
    );
  }

  /** A new secret; the previous one stops verifying at once (deliveries are signed when they are sent). */
  rotateSecret(scope: TenantScope, id: string) {
    return this.gate.execute(
      { action: ACTION, tenantId: scope.tenantId, entitlement: ENTITLEMENT },
      () =>
        this.tx.run(async () => {
          const current = await this.load(scope, id);
          const secret = await this.keys.secretFor({
            id,
            secretVersion: current.secretVersion + 1,
          });
          const row = await this.repo.updateEndpoint(scope, id, current.version, {
            secretVersion: current.secretVersion + 1,
          });
          if (!row) throw AppError.conflict('integration.webhook.version_conflict');
          await this.audit.record({
            action: 'integration.webhook.rotate_secret',
            entityType: 'webhook_endpoint',
            entityId: id,
            tenantId: scope.tenantId,
            propertyId: row.propertyId,
            after: { secret_version: row.secretVersion },
          });
          return { endpoint: presentEndpoint(row), secret };
        }),
    );
  }

  deliveries(scope: TenantScope, id: string, query: WebhookDeliveriesQuery) {
    return this.gate.execute(
      { action: ACTION, tenantId: scope.tenantId, entitlement: ENTITLEMENT },
      () =>
        this.tx.read(async () => {
          await this.load(scope, id, false);
          const rows = await this.repo.deliveries(scope, id, query.status, query.limit);
          return rows.map(presentDelivery);
        }),
    );
  }

  /** Sends a delivery again (typically one in the dead-letter state), with a fresh attempt budget. */
  replay(scope: TenantScope, id: string, deliveryId: string) {
    return this.gate.execute(
      { action: ACTION, tenantId: scope.tenantId, entitlement: ENTITLEMENT },
      () =>
        this.tx.run(async () => {
          await this.load(scope, id);
          const delivery = isUuid(deliveryId)
            ? await this.repo.delivery(scope, deliveryId)
            : undefined;
          if (!delivery || delivery.endpointId !== id)
            throw AppError.notFound('integration.webhook.delivery_not_found');
          if (delivery.status === 'PENDING')
            throw AppError.conflict('integration.webhook.delivery_pending');
          const row = (await this.repo.requeue(scope, deliveryId, new Date()))!;
          await this.audit.record({
            action: 'integration.webhook.replay',
            entityType: 'webhook_delivery',
            entityId: deliveryId,
            tenantId: scope.tenantId,
            before: { status: delivery.status, attempts: delivery.attempts },
            after: { status: row.status, replays: row.replays },
          });
          return presentDelivery(row);
        }),
    );
  }

  private async load(scope: TenantScope, id: string, lock = true): Promise<WebhookEndpointRow> {
    const row = isUuid(id) ? await this.repo.endpoint(scope, id, lock) : undefined;
    if (!row) throw AppError.notFound('integration.webhook.not_found');
    return row;
  }

  private assertTarget(url: string): void {
    const problem = targetProblem(url, this.config.webhooks.allowInsecure);
    if (problem)
      throw new AppError(`integration.webhook.url_${problem}`, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

export function presentEndpoint(row: WebhookEndpointRow) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    url: row.url,
    eventTypes: row.eventTypes,
    description: row.description,
    status: row.status,
    secretVersion: row.secretVersion,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function presentDelivery(row: WebhookDeliveryRow) {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.status === 'PENDING' ? row.nextAttemptAt : null,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt,
    replays: row.replays,
    createdAt: row.createdAt,
  };
}
