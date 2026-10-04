import { Inject, Injectable } from '@nestjs/common';
import {
  type AgentFrame,
  type BatchResponse,
  type LinkMessage,
  type PlatformFrame,
  type LicenceBody,
} from '@hotella/contracts-connectors';
import { IntegrationExceptionOpened } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import {
  DATABASE,
  type Database,
  newId,
  type TenantScope,
  withTransaction,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { signCanonical } from '@hotella/platform-pki';
import { HealthService } from '../application/health.service';
import { IngestService } from '../application/ingest.service';
import { IntegrationRepositories } from '../infrastructure/repositories';
import { LinkRepositories } from '../infrastructure/link-repositories';
import type { AgentLinkRow, IntegrationInstanceRow } from '../infrastructure/schema';
import { AgentKeys } from './agent-keys';

/** An authenticated agent: its instance and link row, resolved from the client certificate. */
export interface AgentSession {
  readonly instance: IntegrationInstanceRow;
  readonly link: AgentLinkRow;
  readonly scope: TenantScope;
}

export type MessageOutcome =
  | { readonly kind: 'ack'; readonly sequence: number }
  | { readonly kind: 'resend'; readonly from: number };

/**
 * The platform side of the hotel-agent link (ADR-0017 §3–§5), independent of the transport (WSS or HTTPS batch):
 * authentication by certificate fingerprint, capability report, strictly ordered and cumulatively acknowledged
 * messages, heartbeats feeding health, and signed command delivery with results.
 *
 * One instance's link is served by one gateway replica at a time (sticky by instance); within it messages are
 * processed one at a time. Correctness does not depend on that: the sequence only advances by compare-and-set, and
 * a repeated source message id is a no-op in the inbox.
 */
/** A licence lasts this long and is renewed at every welcome; offline, the agent keeps working through the grace. */
const LICENCE_DAYS = 30;
const LICENCE_GRACE_DAYS = 14;

@Injectable()
export class AgentLinkService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: IntegrationRepositories,
    private readonly links: LinkRepositories,
    private readonly ingest: IngestService,
    private readonly health: HealthService,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly keys: AgentKeys,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** The agent behind a presented client certificate, or null (unknown, revoked, expired, disabled). */
  async authenticate(fingerprint: string | null): Promise<AgentSession | null> {
    if (!fingerprint) return null;
    const link = await this.links.linkByFingerprint(fingerprint);
    if (!link || link.revokedAt || !link.certNotAfter || link.certNotAfter.getTime() < Date.now())
      return null;
    const scope = { tenantId: link.tenantId };
    const instance = await this.repo.instance(scope, link.instanceId);
    if (!instance || instance.status === 'DISABLED') return null;
    return { instance, link, scope };
  }

  /** Session start: records what the agent can serve and tells it where to resume. */
  async hello(
    session: AgentSession,
    frame: Extract<AgentFrame, { type: 'hello' }>,
    sessionId: string,
  ): Promise<PlatformFrame> {
    const { instance, scope } = session;
    if (frame.connector_code !== instance.connectorCode)
      throw new AppError('integration.agent.connector_mismatch', 409);
    return withTransaction(
      this.db,
      async () => {
        const fresh = await this.repo.instance(scope, instance.id);
        await this.repo.updateInstance(scope, instance.id, fresh!.version, {
          reportedCapabilities: [...new Set(frame.capabilities)],
        });
        let link = (await this.links.updateLink(scope, instance.id, {
          sessionId,
          agentVersion: frame.agent_version,
          lastConnectedAt: new Date(),
        }))!;
        // The agent no longer holds what we expect next (reinstalled, or its buffer was evicted): accept the jump and
        // make the gap visible to staff instead of waiting forever (reconciliation finds anything lost).
        const first = frame.first_buffered_sequence;
        if (first !== null && first > link.lastSequenceNo + 1) {
          const from = link.lastSequenceNo + 1;
          await this.links.advanceSequence(scope, instance.id, link.lastSequenceNo, first - 1);
          link = (await this.links.link(scope, instance.id))!;
          await this.openGapException(instance, from, first - 1);
        }
        await this.links.requeueSent(scope, instance.id);
        await this.health.recordAgentSeen(scope, instance.id, null);
        return {
          type: 'welcome',
          session_id: sessionId,
          instance_id: instance.id,
          next_expected_sequence: link.lastSequenceNo + 1,
          heartbeat_interval_seconds: this.config.agent.heartbeatSeconds,
          server_time: new Date().toISOString(),
          licence: await this.licence(fresh!),
        };
      },
      { tenantId: scope.tenantId },
    );
  }

  /**
   * The agent's licence (Spec §62): what this instance may serve, valid for {@link LICENCE_DAYS} with an offline grace,
   * renewed at every welcome. Signed with the command key; the `typ` keeps a licence from ever passing as a command.
   * Phase 11 derives it from the tenant's entitlements instead of the instance alone.
   */
  private async licence(instance: IntegrationInstanceRow) {
    const now = new Date();
    const body: LicenceBody = {
      typ: 'hotella.licence.v1',
      instance_id: instance.id,
      tenant_id: instance.tenantId,
      property_id: instance.propertyId,
      connector_code: instance.connectorCode,
      capabilities: [...instance.enabledCapabilities] as LicenceBody['capabilities'],
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + LICENCE_DAYS * 86_400_000).toISOString(),
      grace_days: LICENCE_GRACE_DAYS,
    };
    return { ...body, signature: signCanonical(body, (await this.keys.get()).commandSigningKey) };
  }

  /** One inbound message, in strict sequence order. */
  message(session: AgentSession, frame: LinkMessage): Promise<MessageOutcome> {
    return this.serialized(session.instance.id, () => this.processMessage(session, frame));
  }

  /** An HTTPS batch: processed in order until done or a gap is found. */
  batch(session: AgentSession, messages: readonly LinkMessage[]): Promise<BatchResponse> {
    return this.serialized(session.instance.id, async () => {
      let ackedThrough = (await this.links.link(session.scope, session.instance.id))!
        .lastSequenceNo;
      for (const m of [...messages].sort((a, b) => a.sequence_no - b.sequence_no)) {
        const outcome = await this.processMessage(session, m);
        if (outcome.kind === 'resend')
          return { acked_through: ackedThrough, resend_from: outcome.from };
        ackedThrough = Math.max(ackedThrough, outcome.sequence);
      }
      return { acked_through: ackedThrough, resend_from: null };
    });
  }

  async heartbeat(
    session: AgentSession,
    frame: Extract<AgentFrame, { type: 'heartbeat' }>,
  ): Promise<void> {
    await withTransaction(
      this.db,
      () => this.health.recordAgentSeen(session.scope, session.instance.id, frame.queue_depth),
      { tenantId: session.scope.tenantId },
    );
  }

  async disconnected(session: AgentSession, sessionId: string): Promise<void> {
    await withTransaction(
      this.db,
      async () => {
        const link = await this.links.link(session.scope, session.instance.id);
        if (link?.sessionId === sessionId)
          await this.links.updateLink(session.scope, session.instance.id, {
            sessionId: null,
            lastDisconnectedAt: new Date(),
          });
      },
      { tenantId: session.scope.tenantId },
    );
  }

  /** Still allowed to talk? (certificate not revoked or replaced, instance not disabled). */
  async stillValid(session: AgentSession): Promise<boolean> {
    return (await this.authenticate(session.link.certFingerprint)) !== null;
  }

  /** Pending commands, signed and marked SENT; expired ones are closed first. */
  async commandsToSend(session: AgentSession): Promise<PlatformFrame[]> {
    const { scope, instance } = session;
    const keys = await this.keys.get();
    return withTransaction(
      this.db,
      async () => {
        for (const expired of await this.links.expireCommands(scope, instance.id))
          await this.auditCommand(
            session,
            expired.id,
            'integration.command.expire',
            expired.status,
          );
        const pending = await this.links.deliverable(scope, instance.id);
        if (pending.length === 0) return [];
        await this.links.markSent(
          scope,
          pending.map((c) => c.id),
        );
        return pending.map((c) => {
          const body = {
            type: 'command' as const,
            command_id: c.id,
            instance_id: instance.id,
            command_type: c.commandType,
            payload: c.payload,
            idempotency_key: c.idempotencyKey,
            issued_at: c.createdAt.toISOString(),
            expires_at: c.expiresAt?.toISOString() ?? null,
          };
          return { ...body, signature: signCanonical(body, keys.commandSigningKey) };
        });
      },
      { tenantId: scope.tenantId },
    );
  }

  async commandResult(
    session: AgentSession,
    frame: Extract<AgentFrame, { type: 'command_result' }>,
  ): Promise<void> {
    await withTransaction(
      this.db,
      async () => {
        const command = await this.links.command(session.scope, frame.command_id);
        if (!command || command.instanceId !== session.instance.id) return;
        if (command.status === 'ACKNOWLEDGED' || command.status === 'FAILED') return;
        await this.links.markCommands(session.scope, [command.id], {
          status: frame.status,
          acknowledgedAt: new Date(),
          error: frame.error,
        });
        await this.auditCommand(session, command.id, 'integration.command.result', frame.status);
      },
      { tenantId: session.scope.tenantId },
    );
  }

  private async processMessage(session: AgentSession, frame: LinkMessage): Promise<MessageOutcome> {
    const { scope, instance } = session;
    const link = (await this.links.link(scope, instance.id))!;
    const last = link.lastSequenceNo;
    if (frame.sequence_no <= last) return { kind: 'ack', sequence: last };
    if (frame.sequence_no > last + 1) return { kind: 'resend', from: last + 1 };
    await this.ingest.ingest(instance.id, {
      message_type: frame.message_type,
      source_message_id: frame.source_message_id,
      sequence_no: frame.sequence_no,
      occurred_at: frame.occurred_at,
      payload: frame.payload,
    });
    const advanced = await withTransaction(
      this.db,
      () => this.links.advanceSequence(scope, instance.id, last, frame.sequence_no),
      { tenantId: scope.tenantId },
    );
    if (!advanced) {
      const now = (await this.links.link(scope, instance.id))!.lastSequenceNo;
      return now >= frame.sequence_no
        ? { kind: 'ack', sequence: now }
        : { kind: 'resend', from: now + 1 };
    }
    return { kind: 'ack', sequence: frame.sequence_no };
  }

  private async openGapException(instance: IntegrationInstanceRow, from: number, to: number) {
    const id = await this.repo.insertException({
      id: newId(),
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      instanceId: instance.id,
      kind: 'CONFLICT',
      detail: { reason: 'sequence_gap', from, to },
    });
    await this.events.publish(IntegrationExceptionOpened, {
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      source: 'integration',
      aggregate: { type: 'integration_exception', id },
      payload: {
        exception_id: id,
        instance_id: instance.id,
        kind: 'CONFLICT',
        mapping_type: null,
        external_code: null,
      },
    });
    this.logger.warn({ instance_id: instance.id, from, to }, 'agent link sequence gap accepted');
  }

  private async auditCommand(
    session: AgentSession,
    commandId: string,
    action: string,
    status: string,
  ) {
    await this.audit.record({
      action,
      entityType: 'integration_command',
      entityId: commandId,
      tenantId: session.instance.tenantId,
      propertyId: session.instance.propertyId,
      actor: { type: 'INTEGRATION', id: session.instance.id },
      after: { status },
    });
  }

  /** Runs `fn` after every earlier task of the same instance (in-process ordering). */
  private serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }
}
