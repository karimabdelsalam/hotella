import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type MappingType,
  orderingKeyOf,
  rawInboundMessageSchema,
  type RawInboundMessageInput,
  RECORD_CAPABILITY,
} from '@hotella/contracts-connectors';
import { IntegrationExceptionOpened } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import {
  DATABASE,
  type Database,
  type TenantScope,
  withTransaction,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { ConnectorRegistry } from '../connectors/registry';
import { effectiveCapabilities } from '../domain/instance';
import { codesOf, isSyncRecord, toCanonical } from '../domain/mapping';
import { IntegrationRepositories } from '../infrastructure/repositories';
import { HealthService } from './health.service';
import { ReconciliationService } from './reconciliation.service';
import type { IntegrationInstanceRow, IntegrationMessageRow } from '../infrastructure/schema';

export interface IngestResult {
  readonly outcome: 'accepted' | 'duplicate';
  readonly messageId: string;
  readonly status: IntegrationMessageRow['status'];
}

/**
 * The inbound pipeline (Spec §50): raw vendor message → `integration_messages` → parser → mapper → canonical event
 * (outbox). Unknown codes never get guessed: a REQUIRED code parks the message as PENDING_MAPPING (and later messages
 * for the same reservation/room wait behind it as HELD), an OPTIONAL code leaves the canonical field empty. Every gap
 * is an integration exception for a human.
 */
@Injectable()
export class IngestService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: IntegrationRepositories,
    private readonly connectors: ConnectorRegistry,
    private readonly events: EventPublisher,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    private readonly health: HealthService,
    private readonly reconciliation: ReconciliationService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /**
   * Stores a raw message durably (the caller may acknowledge once this returns) and processes it. A message whose
   * (instance, source_message_id) was already received is a no-op: replays and duplicates change nothing.
   */
  async ingest(instanceId: string, input: RawInboundMessageInput): Promise<IngestResult> {
    const raw = rawInboundMessageSchema.parse(input);
    const instance = await this.repo.instanceUnscoped(instanceId);
    if (!instance) throw AppError.notFound('integration.instance.not_found');
    if (instance.status !== 'ACTIVE')
      throw new AppError('integration.instance.not_active', HttpStatus.CONFLICT);
    const scope: TenantScope = { tenantId: instance.tenantId };

    const stored = await withTransaction(
      this.db,
      () =>
        this.repo.insertMessage({
          tenantId: instance.tenantId,
          propertyId: instance.propertyId,
          instanceId: instance.id,
          messageType: raw.message_type,
          sourceMessageId: raw.source_message_id,
          sequenceNo: raw.sequence_no,
          occurredAt: raw.occurred_at ? new Date(raw.occurred_at) : null,
          payload: raw.payload ?? {},
        }),
      { tenantId: instance.tenantId },
    );
    if (!stored) {
      const existing = await this.repo.messageBySource(scope, instance.id, raw.source_message_id);
      return { outcome: 'duplicate', messageId: existing!.id, status: existing!.status };
    }
    const status = await this.processSafely(scope, stored.id);
    return { outcome: 'accepted', messageId: stored.id, status };
  }

  /** Processing in its own transaction; an unexpected failure marks the message FAILED instead of losing it. */
  /** Processes a stored message again (replay); same safety net as ingestion. */
  async reprocess(scope: TenantScope, messageId: string): Promise<IntegrationMessageRow['status']> {
    return this.processSafely(scope, messageId);
  }

  private async processSafely(
    scope: TenantScope,
    messageId: string,
  ): Promise<IntegrationMessageRow['status']> {
    try {
      return await withTransaction(this.db, () => this.process(scope, messageId), {
        tenantId: scope.tenantId,
      });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      this.logger.error({ message_id: messageId, err: error }, 'integration message failed');
      await withTransaction(
        this.db,
        async () => {
          const m = await this.repo.updateMessage(scope, messageId, {
            status: 'FAILED',
            error,
          });
          await this.health.recordMessage(scope, m.instanceId, true);
        },
        { tenantId: scope.tenantId },
      );
      return 'FAILED';
    }
  }

  private async process(
    scope: TenantScope,
    messageId: string,
  ): Promise<IntegrationMessageRow['status']> {
    const m = await this.repo.messageForUpdate(scope, messageId);
    if (!m) throw new Error('message vanished');
    if (m.status === 'PROCESSED') return m.status;
    const instance = (await this.repo.instance(scope, m.instanceId))!;
    const attempts = m.attempts + 1;
    const adapter = this.connectors.get(instance.connectorCode);
    const effective = new Set<string>(effectiveCapabilities(instance));
    const messageType = adapter?.manifest.messageTypes.find((t) => t.code === m.messageType);

    if (!adapter || !messageType || !effective.has(messageType.requires)) {
      const error = !messageType
        ? `message type ${m.messageType} is not defined by ${instance.connectorCode}`
        : `capability ${messageType.requires} is not enabled for this instance`;
      await this.repo.updateMessage(scope, m.id, { status: 'REJECTED', attempts, error });
      await this.openException(instance, {
        messageId: m.id,
        kind: 'UNSUPPORTED_MESSAGE',
        detail: { message_type: m.messageType, requires: messageType?.requires ?? null },
      });
      await this.health.recordMessage(scope, instance.id, true);
      return 'REJECTED';
    }

    const property = await this.org.getProperty(instance.tenantId, instance.propertyId);
    const parsed = adapter.parse(
      {
        message_type: m.messageType,
        source_message_id: m.sourceMessageId,
        sequence_no: m.sequenceNo,
        occurred_at: m.occurredAt?.toISOString() ?? null,
        payload: m.payload,
      },
      { timezone: property?.timezone ?? 'UTC', receivedAt: m.receivedAt.toISOString() },
    );
    if (!parsed.ok) {
      await this.repo.updateMessage(scope, m.id, {
        status: 'FAILED',
        attempts,
        error: parsed.error,
      });
      await this.openException(instance, {
        messageId: m.id,
        kind: 'PARSE_ERROR',
        detail: { message_type: m.messageType, error: parsed.error },
      });
      await this.health.recordMessage(scope, instance.id, true);
      return 'FAILED';
    }

    // Records for capabilities this hotel has not enabled are not applied (Spec §47).
    const records = parsed.records.filter((r) => effective.has(RECORD_CAPABILITY[r.kind]));
    const orderingKeys = [...new Set(records.map(orderingKeyOf))];

    if (
      await this.repo.hasBlockedPredecessor(scope, {
        id: m.id,
        instanceId: m.instanceId,
        orderingKeys,
      })
    ) {
      await this.repo.updateMessage(scope, m.id, {
        status: 'HELD',
        attempts,
        orderingKeys,
        error: 'waiting for an earlier message with the same reservation or room',
      });
      return 'HELD';
    }

    const needs = records.flatMap(codesOf);
    const mappings = await this.repo.mappingsFor(scope, instance.id, needs);
    const resolved = new Map(mappings.map((x) => [`${x.mappingType}:${x.externalCode}`, x]));
    const missing = dedupe(needs.filter((n) => !resolved.has(`${n.type}:${n.code}`)));
    for (const n of missing) await this.openUnknownCode(instance, m.id, n.type, n.code, n.required);

    const blocking = missing.filter((n) => n.required);
    if (blocking.length > 0) {
      await this.repo.updateMessage(scope, m.id, {
        status: 'PENDING_MAPPING',
        attempts,
        orderingKeys,
        error: `unmapped: ${blocking.map((n) => `${n.type} ${n.code}`).join(', ')}`,
      });
      await this.health.recordMessage(scope, instance.id, false);
      return 'PENDING_MAPPING';
    }

    // Room numbers come from the organization context (the internal room behind each mapping).
    const roomNumbers = new Map<string, string>();
    for (const x of mappings.filter((y) => y.mappingType === 'ROOM')) {
      if (!needs.some((n) => n.type === 'ROOM' && n.code === x.externalCode)) continue;
      const room = await this.org.getRoom(instance.tenantId, instance.propertyId, x.internalValue);
      if (!room) {
        const error = `mapping ROOM ${x.externalCode} points to a room that no longer exists`;
        await this.repo.updateMessage(scope, m.id, {
          status: 'PENDING_MAPPING',
          attempts,
          orderingKeys,
          error,
        });
        await this.openException(instance, {
          messageId: m.id,
          kind: 'CONFLICT',
          mappingType: 'ROOM',
          externalCode: x.externalCode,
          detail: { reason: 'mapped_room_missing' },
        });
        return 'PENDING_MAPPING';
      }
      roomNumbers.set(room.id, room.roomNumber);
    }

    const eventIds: string[] = [];
    for (const [i, record] of records.entries()) {
      if (isSyncRecord(record)) {
        const roomId =
          record.kind === 'IN_HOUSE_ENTRY' && record.room_code
            ? (resolved.get(`ROOM:${record.room_code}`)?.internalValue ?? null)
            : null;
        await this.reconciliation.onSync(instance, record, roomId);
        continue;
      }
      const draft = toCanonical(record, instance.id, {
        get: (type, code) => resolved.get(`${type}:${code}`)?.internalValue,
        roomNumber: (roomId) => roomNumbers.get(roomId)!,
      });
      const envelope = await this.events.publish(draft.definition, {
        tenantId: instance.tenantId,
        propertyId: instance.propertyId,
        source: `integration:${instance.connectorCode}`,
        sourceReference: `${instance.id}:${m.sourceMessageId}#${i}`,
        aggregate: { type: 'integration_message', id: m.id },
        occurredAt: new Date(draft.occurredAt),
        payload: draft.payload,
      });
      eventIds.push(envelope.event_id);
    }
    await this.repo.updateMessage(scope, m.id, {
      status: 'PROCESSED',
      attempts,
      orderingKeys,
      processedAt: new Date(),
      canonicalEventIds: eventIds,
      error: null,
    });
    await this.health.recordMessage(scope, instance.id, false);

    // Messages that waited behind this one may proceed now, in order.
    for (const held of await this.repo.heldSuccessors(scope, instance.id, m.id, orderingKeys))
      await this.process(scope, held.id);
    return 'PROCESSED';
  }

  private async openUnknownCode(
    instance: IntegrationInstanceRow,
    messageId: string,
    type: MappingType,
    code: string,
    required: boolean,
  ): Promise<void> {
    const opened = await this.repo.upsertUnknownCode({
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      instanceId: instance.id,
      messageId,
      mappingType: type,
      externalCode: code,
      detail: { required },
    });
    if (opened) await this.publishOpened(instance, opened, 'UNKNOWN_MAPPING', type, code);
  }

  private async openException(
    instance: IntegrationInstanceRow,
    values: {
      messageId: string;
      kind: 'PARSE_ERROR' | 'UNSUPPORTED_MESSAGE' | 'CONFLICT';
      mappingType?: MappingType;
      externalCode?: string;
      detail: Record<string, unknown>;
    },
  ): Promise<void> {
    const id = await this.repo.insertException({
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      instanceId: instance.id,
      messageId: values.messageId,
      kind: values.kind,
      mappingType: values.mappingType ?? null,
      externalCode: values.externalCode ?? null,
      detail: values.detail,
    });
    await this.publishOpened(
      instance,
      id,
      values.kind,
      values.mappingType ?? null,
      values.externalCode ?? null,
    );
  }

  private async publishOpened(
    instance: IntegrationInstanceRow,
    exceptionId: string,
    kind: 'UNKNOWN_MAPPING' | 'PARSE_ERROR' | 'UNSUPPORTED_MESSAGE' | 'CONFLICT',
    mappingType: string | null,
    externalCode: string | null,
  ): Promise<void> {
    await this.events.publish(IntegrationExceptionOpened, {
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      source: 'integration',
      aggregate: { type: 'integration_exception', id: exceptionId },
      payload: {
        exception_id: exceptionId,
        instance_id: instance.id,
        kind,
        mapping_type: mappingType,
        external_code: externalCode,
      },
    });
  }
}

function dedupe<T extends { type: string; code: string; required: boolean }>(needs: T[]): T[] {
  const seen = new Map<string, T>();
  for (const n of needs) {
    const key = `${n.type}:${n.code}`;
    const prev = seen.get(key);
    if (!prev || (n.required && !prev.required)) seen.set(key, n);
  }
  return [...seen.values()];
}
