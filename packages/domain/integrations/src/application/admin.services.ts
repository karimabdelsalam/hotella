import {
  HttpStatus,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { z } from 'zod';
import { type ConnectorManifest, OUTLET_CATEGORIES } from '@hotella/contracts-connectors';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { catalogRow, ConnectorRegistry } from '../connectors/registry';
import { effectiveCapabilities } from '../domain/instance';
import { CapabilityRepositories } from '../infrastructure/capability-repositories';
import { CapabilityRegistry } from './capability-registry';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { IntegrationInstanceRow, IntegrationMappingRow } from '../infrastructure/schema';
import type {
  CloseExceptionInput,
  ConfirmMappingInput,
  CreateInstanceInput,
  ListExceptionsQuery,
  ListMessagesQuery,
  UpdateInstanceInput,
} from './dto';

const CANONICAL_CODE_RE = /^[A-Z0-9][A-Z0-9_]{0,31}$/;

const CATALOG_RETRY_MS = 15_000;

/**
 * Keeps `integration.connector_definitions` in sync with the code-defined connectors at every boot. While the database
 * is unreachable it retries in the background, so the API still starts and reports /ready honestly.
 */
@Injectable()
export class ConnectorCatalogService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly registry: ConnectorRegistry,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.attempt();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async attempt(): Promise<void> {
    try {
      await this.tx.run(async () => {
        for (const m of this.registry.manifests()) await this.repo.upsertConnector(catalogRow(m));
      });
      this.logger.info(
        { connectors: this.registry.manifests().length },
        'connector catalog synced',
      );
    } catch (err) {
      this.logger.warn({ err }, 'connector catalog sync failed; retrying');
      this.timer = setTimeout(() => void this.attempt(), CATALOG_RETRY_MS);
      this.timer.unref();
    }
  }

  list() {
    return this.repo.listConnectors();
  }
}

/** Instance view for staff: never exposes credential reference values, only their names. */
export function presentInstance(i: IntegrationInstanceRow) {
  return {
    id: i.id,
    tenantId: i.tenantId,
    propertyId: i.propertyId,
    connectorCode: i.connectorCode,
    name: i.name,
    status: i.status,
    config: i.config,
    credentialNames: Object.keys((i.credentialRefs as Record<string, string>) ?? {}),
    enabledCapabilities: i.enabledCapabilities,
    reportedCapabilities: i.reportedCapabilities,
    effectiveCapabilities: effectiveCapabilities(i),
    version: i.version,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

@Injectable()
export class InstanceService {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly registry: ConnectorRegistry,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly capabilities: CapabilityRegistry,
    private readonly caps: CapabilityRepositories,
    private readonly actors: ActorStore,
  ) {}

  create(scope: PropertyScope, input: CreateInstanceInput) {
    return this.gate.execute(
      { action: 'integration.configure', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const manifest = this.manifest(input.connectorCode);
          const config = validateAgainst(manifest.configSchema, input.config, 'config_invalid');
          const credentialRefs = validateAgainst(
            manifest.credentialSchema,
            input.credentialRefs,
            'credentials_invalid',
          );
          assertCapabilities(manifest, input.capabilities);
          const existing = await this.repo.listInstances(scope);
          if (existing.some((i) => i.name === input.name))
            throw AppError.conflict('integration.instance.name_taken', { name: input.name });
          const row = await this.repo.insertInstance({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            connectorCode: manifest.code,
            name: input.name,
            config,
            credentialRefs,
            enabledCapabilities: [...new Set(input.capabilities)],
          });
          await this.repo.insertHealth({
            instanceId: row.id,
            tenantId: row.tenantId,
            propertyId: row.propertyId,
          });
          await this.audit.record({
            action: 'integration.instance.create',
            entityType: 'integration_instance',
            entityId: row.id,
            tenantId: row.tenantId,
            propertyId: row.propertyId,
            after: presentInstance(row),
          });
          await this.enablementHistory(scope, row.id, [], row.enabledCapabilities);
          await this.capabilities.refresh(scope);
          return presentInstance(row);
        }),
    );
  }

  update(scope: PropertyScope, id: string, input: UpdateInstanceInput) {
    return this.gate.execute(
      { action: 'integration.configure', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const before = await this.load(scope, id);
          const manifest = this.manifest(before.connectorCode);
          const values: Partial<IntegrationInstanceRow> = {};
          if (input.name !== undefined) values.name = input.name;
          if (input.status !== undefined) values.status = input.status;
          if (input.config !== undefined)
            values.config = validateAgainst(manifest.configSchema, input.config, 'config_invalid');
          if (input.credentialRefs !== undefined)
            values.credentialRefs = validateAgainst(
              manifest.credentialSchema,
              input.credentialRefs,
              'credentials_invalid',
            );
          if (input.capabilities !== undefined) {
            assertCapabilities(manifest, input.capabilities);
            values.enabledCapabilities = [...new Set(input.capabilities)];
          }
          const row = await this.repo.updateInstance(scope, id, input.version, values);
          if (!row) throw AppError.conflict('platform.conflict');
          await this.audit.record({
            action: 'integration.instance.update',
            entityType: 'integration_instance',
            entityId: row.id,
            tenantId: row.tenantId,
            propertyId: row.propertyId,
            before: presentInstance(before),
            after: presentInstance(row),
          });
          await this.enablementHistory(
            scope,
            row.id,
            before.enabledCapabilities,
            row.enabledCapabilities,
          );
          await this.capabilities.refresh(scope);
          return presentInstance(row);
        }),
    );
  }

  list(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(async () => (await this.repo.listInstances(scope)).map(presentInstance)),
    );
  }

  get(scope: PropertyScope, id: string) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const instance = await this.load(scope, id);
          const health = await this.repo.health(scope, id);
          return { ...presentInstance(instance), health: health ?? null };
        }),
    );
  }

  messages(scope: PropertyScope, id: string, query: ListMessagesQuery) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.load(scope, id);
          // Metadata only: raw payloads carry guest data and are not exposed through the staff API.
          return (await this.repo.listMessages(scope, id, query)).map((m) => ({
            id: m.id,
            messageType: m.messageType,
            sourceMessageId: m.sourceMessageId,
            sequenceNo: m.sequenceNo,
            receivedAt: m.receivedAt,
            occurredAt: m.occurredAt,
            status: m.status,
            attempts: m.attempts,
            processedAt: m.processedAt,
            canonicalEventIds: m.canonicalEventIds,
            error: m.error,
          }));
        }),
    );
  }

  /** Enabling or disabling a capability is a commissioning decision kept in the capability history (rule 10). */
  private async enablementHistory(
    scope: PropertyScope,
    instanceId: string,
    before: readonly string[],
    after: readonly string[],
  ): Promise<void> {
    const actor = this.actors.require();
    const changes = [
      ...after.filter((c) => !before.includes(c)).map((c) => [c, 'ENABLED'] as const),
      ...before.filter((c) => !after.includes(c)).map((c) => [c, 'DISABLED'] as const),
    ];
    for (const [capability, action] of changes)
      await this.caps.history({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        instanceId,
        capability,
        action,
        actorType: actor.type,
        actorId: actor.id,
      });
  }

  async load(scope: PropertyScope, id: string): Promise<IntegrationInstanceRow> {
    const row = isUuid(id) ? await this.repo.instance(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('integration.instance.not_found');
    return row;
  }

  private manifest(code: string): ConnectorManifest {
    const adapter = this.registry.get(code);
    if (!adapter) throw AppError.notFound('integration.connector.not_found', { code });
    return adapter.manifest;
  }
}

@Injectable()
export class MappingService {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly instances: InstanceService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  list(scope: PropertyScope, instanceId: string, type?: IntegrationMappingRow['mappingType']) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.instances.load(scope, instanceId);
          return this.repo.listMappings(scope, instanceId, type);
        }),
    );
  }

  /** A human confirms what an external code means (Spec §52). Never inferred by the platform. */
  confirm(scope: PropertyScope, instanceId: string, input: ConfirmMappingInput) {
    return this.gate.execute(
      {
        action: 'integration.mapping.confirm',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const instance = await this.instances.load(scope, instanceId);
          await this.validateInternalValue(scope, input);
          const actorId = this.actorId();
          const existing = await this.repo.mapping(
            scope,
            instanceId,
            input.mappingType,
            input.externalCode,
          );
          let row: IntegrationMappingRow;
          if (existing) {
            if (existing.internalValue === input.internalValue) return existing;
            if (input.version === undefined || input.version !== existing.version)
              throw AppError.conflict('platform.conflict');
            const updated = await this.repo.updateMapping(scope, existing.id, existing.version, {
              internalValue: input.internalValue,
              confirmedBy: actorId,
              confirmedAt: new Date(),
            });
            if (!updated) throw AppError.conflict('platform.conflict');
            row = updated;
          } else {
            const inserted = await this.repo.insertMapping({
              id: newId(),
              tenantId: instance.tenantId,
              propertyId: instance.propertyId,
              instanceId,
              mappingType: input.mappingType,
              externalCode: input.externalCode,
              internalValue: input.internalValue,
              confirmedBy: actorId,
            });
            if (!inserted) throw AppError.conflict('platform.conflict');
            row = inserted;
          }
          await this.repo.resolveUnknownCode(
            scope,
            instanceId,
            input.mappingType,
            input.externalCode,
            actorId,
          );
          await this.audit.record({
            action: 'integration.mapping.confirm',
            entityType: 'integration_mapping',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: existing ?? null,
            after: row,
          });
          return row;
        }),
    );
  }

  /**
   * Onboarding helper: an administrator confirms in one action that the PMS room codes equal the room numbers
   * configured in Hotella. Only exact matches are created; nothing is inferred for codes that differ.
   */
  confirmRoomsByNumber(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      {
        action: 'integration.mapping.confirm',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const instance = await this.instances.load(scope, instanceId);
          const actorId = this.actorId();
          const rooms = await this.org.listRooms(scope.tenantId, scope.propertyId);
          let created = 0;
          for (const room of rooms) {
            const inserted = await this.repo.insertMapping({
              id: newId(),
              tenantId: instance.tenantId,
              propertyId: instance.propertyId,
              instanceId,
              mappingType: 'ROOM',
              externalCode: room.roomNumber,
              internalValue: room.id,
              confirmedBy: actorId,
            });
            if (!inserted) continue;
            created++;
            await this.repo.resolveUnknownCode(scope, instanceId, 'ROOM', room.roomNumber, actorId);
          }
          await this.audit.record({
            action: 'integration.mapping.confirm_rooms_by_number',
            entityType: 'integration_instance',
            entityId: instanceId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { rooms: rooms.length, created },
          });
          return { rooms: rooms.length, created };
        }),
    );
  }

  private async validateInternalValue(scope: PropertyScope, input: ConfirmMappingInput) {
    // Telemetry points are mapped where they are defined: engineering's point registry (BUILD_PLAN 13.2).
    if (input.mappingType === 'POINT')
      throw new AppError(
        'integration.mapping.point_in_engineering',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    if (input.mappingType === 'ROOM') {
      const room = isUuid(input.internalValue)
        ? await this.org.getRoom(scope.tenantId, scope.propertyId, input.internalValue)
        : null;
      if (!room)
        throw new AppError('integration.mapping.room_not_found', HttpStatus.UNPROCESSABLE_ENTITY);
      return;
    }
    // A POS outlet is one of a fixed set of categories (BUILD_PLAN 13.5).
    if (
      input.mappingType === 'OUTLET' &&
      !(OUTLET_CATEGORIES as readonly string[]).includes(input.internalValue)
    )
      throw new AppError('integration.mapping.invalid_outlet', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!CANONICAL_CODE_RE.test(input.internalValue))
      throw new AppError('integration.mapping.invalid_code', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private actorId(): string | null {
    const id = this.actors.get()?.id;
    return id && isUuid(id) ? id : null;
  }
}

@Injectable()
export class ExceptionService {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
  ) {}

  list(scope: PropertyScope, query: ListExceptionsQuery) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(() => this.repo.listExceptions(scope, query)),
    );
  }

  close(scope: PropertyScope, id: string, input: CloseExceptionInput) {
    return this.gate.execute(
      {
        action: 'integration.mapping.confirm',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const before = isUuid(id) ? await this.repo.exception(scope, id) : undefined;
          if (!before || before.propertyId !== scope.propertyId)
            throw AppError.notFound('integration.exception.not_found');
          const actor = this.actors.get()?.id;
          const row = await this.repo.closeException(scope, id, input.version, {
            status: input.status,
            resolution: input.resolution,
            resolvedBy: actor && isUuid(actor) ? actor : null,
          });
          if (!row) throw AppError.conflict('platform.conflict');
          await this.audit.record({
            action: 'integration.exception.close',
            entityType: 'integration_exception',
            entityId: id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            reason: input.resolution,
            before,
            after: row,
          });
          return row;
        }),
    );
  }
}

function validateAgainst(
  schema: z.ZodType,
  value: unknown,
  code: 'config_invalid' | 'credentials_invalid',
): Record<string, unknown> {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new AppError(`integration.instance.${code}`, HttpStatus.UNPROCESSABLE_ENTITY, {
      issues: r.error.issues.length,
    });
  return r.data as Record<string, unknown>;
}

function assertCapabilities(manifest: ConnectorManifest, requested: readonly string[]): void {
  const supported = new Set<string>(manifest.capabilities);
  const unsupported = requested.filter((c) => !supported.has(c));
  if (unsupported.length > 0)
    throw new AppError(
      'integration.instance.capability_unsupported',
      HttpStatus.UNPROCESSABLE_ENTITY,
      {
        capabilities: unsupported.join(', '),
      },
    );
}
