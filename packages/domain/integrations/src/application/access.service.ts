import { HttpStatus, Injectable } from '@nestjs/common';
import type { ConnectorCapability } from '@hotella/contracts-connectors';
import {
  AccessFailed,
  AccessIssued,
  AccessRevoked,
  type EventEnvelope,
  GuestStayRoomChanged,
  IntegrationExceptionOpened,
  StayStatusChanged,
} from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { effectiveCapabilities } from '../domain/instance';
import { AccessRepositories } from '../infrastructure/access-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { AccessGrantRow } from '../infrastructure/schema';
import type {
  AccessGrantSummary,
  AccessIssueInput,
  AccessKind,
  AccessPublicApi,
  AccessRevokeReason,
} from '../public';
import { IntegrationsPublicApiService } from '../public-api.service';

/** What each kind asks of the connector: the command that issues it, and the one that revokes it. */
const COMMANDS: Record<AccessKind, { issue: ConnectorCapability; revoke: ConnectorCapability }> = {
  KEY: { issue: 'KEY_ENCODE', revoke: 'KEY_REVOKE' },
  MOBILE_KEY: { issue: 'MOBILE_KEY_ISSUE', revoke: 'KEY_REVOKE' },
  WIFI: { issue: 'WIFI_SESSION_CREATE', revoke: 'WIFI_SESSION_REVOKE' },
};
/** A command that waits longer than this for the hotel agent is not sent any more (the desk asks again). */
const ISSUE_TTL_MS = 15 * 60 * 1000;

type Actor = { readonly type: string; readonly id: string | null };

/**
 * Stay-bound access (ADR-0024 §5, BUILD_PLAN 13.3, rule 19). Grants are asked of the property's lock or Wi-Fi
 * connector as commands over the agent link; the command result decides the grant. Leaving the house (any stay status
 * but IN_HOUSE) revokes every live grant of the stay, a room move revokes the keys of the old room. History is kept
 * (rule 10); no key material is ever stored.
 */
@Injectable()
export class AccessService implements AccessPublicApi {
  static readonly consumes = [StayStatusChanged, GuestStayRoomChanged];

  constructor(
    private readonly repo: AccessRepositories,
    private readonly integrations: IntegrationRepositories,
    private readonly commands: IntegrationsPublicApiService,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async available(tenantId: string, propertyId: string, kind: AccessKind): Promise<boolean> {
    return (await this.route({ tenantId }, propertyId, COMMANDS[kind].issue)) !== undefined;
  }

  async issue(input: AccessIssueInput): Promise<AccessGrantSummary> {
    const scope = { tenantId: input.tenantId };
    const capability = COMMANDS[input.kind].issue;
    const instance = await this.route(scope, input.propertyId, capability);
    if (!instance)
      throw new AppError('integration.access.unavailable', HttpStatus.CONFLICT, { capability });
    let grant = await this.repo.insertGrant({
      id: newId(),
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      stayId: input.stayId,
      kind: input.kind,
      roomId: input.roomId,
      roomNumber: input.roomNumber,
      instanceId: instance.id,
      validUntil: input.validUntil,
      requestedByType: input.requestedBy.type,
      requestedById:
        input.requestedBy.id && isUuid(input.requestedBy.id) ? input.requestedBy.id : null,
    });
    await this.history(grant, null, 'REQUESTED', input.requestedBy, null);
    const command = await this.commands.requestCommand({
      tenantId: input.tenantId,
      integrationInstanceId: instance.id,
      commandType: capability,
      payload: {
        grant_id: grant.id,
        room_number: input.roomNumber,
        valid_until: input.validUntil.toISOString(),
      },
      idempotencyKey: `access:${grant.id}:issue`,
      expiresAt: new Date(Date.now() + ISSUE_TTL_MS),
      requestedBy: input.requestedBy,
    });
    grant = await this.repo.updateGrant(scope, grant, { issueCommandId: command.id });
    await this.audit.record({
      action: 'integration.access.issue',
      entityType: 'access_grant',
      entityId: grant.id,
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      after: {
        stay_id: grant.stayId,
        kind: grant.kind,
        room_id: grant.roomId,
        status: grant.status,
      },
    });
    return this.summary(grant, instance.connectorCode);
  }

  async revoke(
    tenantId: string,
    grantId: string,
    reason: AccessRevokeReason,
    requestedBy: Actor,
  ): Promise<AccessGrantSummary | null> {
    const scope = { tenantId };
    const grant = isUuid(grantId) ? await this.repo.grant(scope, grantId) : undefined;
    if (!grant) return null;
    const row = await this.revokeGrant(scope, grant, reason, requestedBy);
    const instance = await this.integrations.instance(scope, row.instanceId);
    return this.summary(row, instance?.connectorCode ?? '');
  }

  async listForStay(tenantId: string, stayId: string): Promise<readonly AccessGrantSummary[]> {
    const scope = { tenantId };
    const rows = await this.repo.grantsOfStay(scope, stayId);
    const codes = new Map<string, string>();
    for (const r of rows)
      if (!codes.has(r.instanceId))
        codes.set(
          r.instanceId,
          (await this.integrations.instance(scope, r.instanceId))?.connectorCode ?? '',
        );
    return rows.map((r) => this.summary(r, codes.get(r.instanceId)!));
  }

  /** The agent answered an access command (called by the link inside its transaction). */
  async onCommandResult(
    scope: TenantScope,
    commandId: string,
    status: 'ACKNOWLEDGED' | 'FAILED' | 'EXPIRED',
    error: string | null,
  ): Promise<void> {
    const grant = await this.repo.grantOfCommand(scope, commandId);
    if (!grant) return;
    const system: Actor = { type: 'INTEGRATION', id: grant.instanceId };
    if (commandId === grant.issueCommandId) {
      if (grant.status !== 'REQUESTED') return; // revoked meanwhile: the revoke command settles it
      if (status === 'ACKNOWLEDGED') {
        const row = await this.repo.updateGrant(scope, grant, {
          status: 'ISSUED',
          issuedAt: new Date(),
        });
        await this.history(row, 'REQUESTED', 'ISSUED', system, null);
        await this.publish(row, AccessIssued);
      } else {
        const row = await this.repo.updateGrant(scope, grant, {
          status: 'FAILED',
          failure: (error ?? status).slice(0, 500),
        });
        await this.history(
          row,
          'REQUESTED',
          'FAILED',
          system,
          status === 'EXPIRED' ? 'EXPIRED' : null,
        );
        await this.publish(row, AccessFailed);
      }
      return;
    }
    if (commandId !== grant.revokeCommandId || grant.status !== 'REVOKE_REQUESTED') return;
    if (status === 'ACKNOWLEDGED') {
      const row = await this.repo.updateGrant(scope, grant, {
        status: 'REVOKED',
        revokedAt: new Date(),
      });
      await this.history(row, 'REVOKE_REQUESTED', 'REVOKED', system, row.revokeReason);
      await this.publish(row, AccessRevoked);
      return;
    }
    // A key that could not be revoked is a security matter: a person must look at it now.
    const row = await this.repo.updateGrant(scope, grant, {
      failure: (error ?? status).slice(0, 500),
    });
    const exceptionId = await this.integrations.insertException({
      id: newId(),
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      instanceId: row.instanceId,
      kind: 'CONFLICT',
      detail: { reason: 'access_revoke_failed', grant_id: row.id, kind: row.kind },
    });
    await this.events.publish(IntegrationExceptionOpened, {
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      source: 'integration',
      aggregate: { type: 'integration_exception', id: exceptionId },
      payload: {
        exception_id: exceptionId,
        instance_id: row.instanceId,
        kind: 'CONFLICT',
        mapping_type: null,
        external_code: null,
      },
    });
    this.logger.warn({ grant_id: row.id, status }, 'access revocation not confirmed');
  }

  /** Worker consumer: leaving the house revokes everything; a room move revokes the old room's keys. */
  async apply(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    if (!tenantId) return;
    const scope = { tenantId };
    const system: Actor = { type: 'SYSTEM', id: null };
    if (envelope.event_type === StayStatusChanged.type) {
      const p = StayStatusChanged.parse(envelope).payload;
      if (p.to === 'IN_HOUSE') return;
      await this.tx.run(async () => {
        for (const grant of await this.repo.liveGrantsOfStay(scope, p.stay_id))
          await this.revokeGrant(
            scope,
            grant,
            p.to === 'CHECKED_OUT' ? 'CHECKED_OUT' : 'STAY_ENDED',
            system,
          );
      });
      return;
    }
    if (envelope.event_type === GuestStayRoomChanged.type) {
      const p = GuestStayRoomChanged.parse(envelope).payload;
      if (!p.from_room_id || p.from_room_id === p.to_room_id || p.reason === 'CHECK_OUT') return;
      await this.tx.run(async () => {
        for (const grant of await this.repo.liveGrantsOfStay(scope, p.stay_id))
          if (grant.kind !== 'WIFI' && grant.roomId === p.from_room_id)
            await this.revokeGrant(scope, grant, 'ROOM_MOVED', system);
      });
    }
  }

  private async revokeGrant(
    scope: TenantScope,
    grant: AccessGrantRow,
    reason: AccessRevokeReason,
    actor: Actor,
  ): Promise<AccessGrantRow> {
    if (grant.status === 'REVOKED' || grant.status === 'REVOKE_REQUESTED') return grant;
    // Nothing was issued: closed without asking the vendor system.
    if (grant.status === 'FAILED') {
      const row = await this.repo.updateGrant(scope, grant, {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokeReason: reason,
      });
      await this.history(row, 'FAILED', 'REVOKED', actor, reason);
      return row;
    }
    // Issued, or perhaps issued (the result has not come back): ask the vendor system to revoke, idempotently.
    const command = await this.commands.requestCommand({
      tenantId: grant.tenantId,
      integrationInstanceId: grant.instanceId,
      commandType: COMMANDS[grant.kind].revoke,
      payload: { grant_id: grant.id },
      idempotencyKey: `access:${grant.id}:revoke`,
      requestedBy: actor,
    });
    const row = await this.repo.updateGrant(scope, grant, {
      status: 'REVOKE_REQUESTED',
      revokeCommandId: command.id,
      revokeReason: reason,
    });
    await this.history(row, grant.status, 'REVOKE_REQUESTED', actor, reason);
    await this.audit.record({
      action: 'integration.access.revoke',
      entityType: 'access_grant',
      entityId: row.id,
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      ...(actor.type === 'SYSTEM' ? { actor: { type: 'SYSTEM', id: null } } : {}),
      before: { status: grant.status },
      after: { status: row.status, reason },
    });
    return row;
  }

  private async route(scope: TenantScope, propertyId: string, capability: ConnectorCapability) {
    return (await this.integrations.listInstances({ ...scope, propertyId }))
      .filter((i) => effectiveCapabilities(i).includes(capability))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
  }

  private history(
    grant: AccessGrantRow,
    from: AccessGrantRow['status'] | null,
    to: AccessGrantRow['status'],
    actor: Actor,
    reason: string | null,
  ) {
    return this.repo.insertEvent({
      id: newId(),
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      grantId: grant.id,
      fromStatus: from,
      toStatus: to,
      actorType: actor.type.slice(0, 16),
      actorId: actor.id && isUuid(actor.id) ? actor.id : null,
      reason,
    });
  }

  private async publish(
    grant: AccessGrantRow,
    definition: typeof AccessIssued | typeof AccessFailed | typeof AccessRevoked,
  ) {
    const meta = {
      tenantId: grant.tenantId,
      propertyId: grant.propertyId,
      source: 'integration',
      aggregate: { type: 'access_grant', id: grant.id },
    };
    const payload = {
      grant_id: grant.id,
      stay_id: grant.stayId,
      kind: grant.kind,
      room_id: grant.roomId,
    };
    if (definition === AccessRevoked)
      await this.events.publish(AccessRevoked, {
        ...meta,
        payload: { ...payload, reason: (grant.revokeReason ?? 'STAFF') as AccessRevokeReason },
      });
    else await this.events.publish(definition, { ...meta, payload });
  }

  private summary(row: AccessGrantRow, connectorCode: string): AccessGrantSummary {
    return {
      id: row.id,
      stayId: row.stayId,
      kind: row.kind,
      roomId: row.roomId,
      roomNumber: row.roomNumber,
      status: row.status,
      validUntil: row.validUntil,
      issuedAt: row.issuedAt,
      revokedAt: row.revokedAt,
      revokeReason: row.revokeReason,
      connectorCode,
      version: row.version,
    };
  }
}
