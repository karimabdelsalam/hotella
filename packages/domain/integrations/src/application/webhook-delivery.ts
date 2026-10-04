import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EventEnvelope } from '@hotella/contracts-events';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { afterFailure, signatureHeader } from '../domain/webhooks';
import { WebhookRepositories } from '../infrastructure/webhook-repositories';
import type { WebhookDeliveryRow } from '../infrastructure/schema';
import { WebhookKeys } from './webhook.service';

const BATCH = 50;
const LEASE_MS = 120_000;
const TIMEOUT_MS = 10_000;

/** What sends one request; tests replace it, production uses `fetch` with a timeout and no redirects. */
export type WebhookTransport = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly body: string },
) => Promise<{ readonly status: number }>;
export const WEBHOOK_TRANSPORT = Symbol.for('hotella.domain.integrations.webhook-transport');

const fetchTransport: WebhookTransport = async (url, init) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  return { status: res.status };
};

/**
 * Outbound webhook delivery (BUILD_PLAN 11.5), in the worker. `enqueue` turns a published event into one delivery per
 * subscribed endpoint (idempotent per endpoint and event, only while the tenant holds API_ACCESS); `sweep` sends the
 * due ones, signed, and settles each as DELIVERED, retried with back-off, or DEAD after the last attempt.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly transport: WebhookTransport;

  constructor(
    private readonly repo: WebhookRepositories,
    private readonly keys: WebhookKeys,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(ENTITLEMENT_API) private readonly entitlements?: EntitlementPublicApi,
    @Optional() @Inject(WEBHOOK_TRANSPORT) transport?: WebhookTransport,
  ) {
    this.transport = transport ?? fetchTransport;
  }

  async enqueue(eventName: string, envelope: EventEnvelope): Promise<number> {
    const tenantId = envelope.tenant_id;
    if (!tenantId) return 0;
    if (this.entitlements && !(await this.entitlements.can(tenantId, null, 'API_ACCESS'))) return 0;
    return this.tx.run(async () => {
      const endpoints = await this.repo.subscribers({ tenantId }, eventName, envelope.property_id);
      let created = 0;
      const now = new Date();
      for (const e of endpoints)
        if (
          await this.repo.insertDelivery({
            id: newId(),
            tenantId,
            endpointId: e.id,
            eventId: envelope.event_id,
            eventType: eventName,
            body: envelope,
            nextAttemptAt: now,
          })
        )
          created++;
      return created;
    });
  }

  /** One pass over due deliveries; returns how many were attempted. */
  async sweep(): Promise<number> {
    const key = await this.keys.signingKey();
    if (!key) return 0;
    let attempted = 0;
    for (;;) {
      const now = new Date();
      const claimed = await this.tx.run(() =>
        this.repo.claimDue(now, new Date(now.getTime() + LEASE_MS), BATCH),
      );
      if (claimed.length === 0) return attempted;
      for (const d of claimed) await this.send(d);
      attempted += claimed.length;
      if (claimed.length < BATCH) return attempted;
    }
  }

  private async send(d: WebhookDeliveryRow): Promise<void> {
    const endpoint = await this.tx.run(() => this.repo.endpointById(d.endpointId));
    if (!endpoint || endpoint.status !== 'ACTIVE') {
      // A paused endpoint keeps its deliveries waiting; they leave with the next sweep after it is resumed.
      await this.tx.run(() =>
        this.repo.settle(d.id, d.attempts, {
          status: 'PENDING',
          nextAttemptAt: new Date(Date.now() + LEASE_MS),
          attempts: d.attempts - 1,
          lastStatusCode: d.lastStatusCode,
          lastError: 'endpoint paused',
        }),
      );
      return;
    }
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const secret = await this.keys.secretFor(endpoint);
      const body = JSON.stringify(d.body);
      const res = await this.transport(endpoint.url, {
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Hotella-Webhooks/1',
          'x-hotella-event': d.eventType,
          'x-hotella-delivery': d.id,
          'x-hotella-signature': signatureHeader(secret, body, new Date()),
        },
        body,
      });
      statusCode = res.status;
      if (res.status >= 200 && res.status < 300) {
        await this.tx.run(() =>
          this.repo.settle(d.id, d.attempts, {
            status: 'DELIVERED',
            lastStatusCode: statusCode,
            lastError: null,
            deliveredAt: new Date(),
          }),
        );
        return;
      }
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err instanceof Error ? err.name : 'Error').slice(0, 300);
    }
    const next = afterFailure(d.attempts, new Date());
    await this.tx.run(() =>
      this.repo.settle(d.id, d.attempts, {
        ...next,
        lastStatusCode: statusCode,
        lastError: error,
      }),
    );
    if (next.status === 'DEAD')
      // Ids only: the URL is CONFIDENTIAL and the body is the tenant's.
      this.logger.warn(
        { delivery_id: d.id, endpoint_id: d.endpointId, attempts: d.attempts },
        'webhook delivery dead after its last attempt',
      );
  }
}
