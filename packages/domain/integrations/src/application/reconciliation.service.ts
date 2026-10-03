import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ReconciliationSnapshotCompleted } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { ConnectorRegistry } from '../connectors/registry';
import { effectiveCapabilities } from '../domain/instance';
import type { SyncRecord } from '../domain/mapping';
import { ReconciliationRepositories } from '../infrastructure/reconciliation-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { IntegrationInstanceRow } from '../infrastructure/schema';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '../public';

/** How long the PMS has to answer a reconciliation request before the command expires. */
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;

/**
 * Reconciliation (Spec §52, ADR-0017 §4): staff (or a schedule) start a run, the agent is asked for its in-house
 * list (a predefined command requiring RECONCILIATION_READ), the snapshot arrives as database-sync records and the
 * stay owner compares it with the platform's stays (`INTEGRATIONS_API.completeReconciliation`).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly runs: ReconciliationRepositories,
    private readonly connectors: ConnectorRegistry,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    private readonly events: EventPublisher,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  start(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.reconcile', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const instance = await this.instance(scope, instanceId);
          const command = this.connectors
            .get(instance.connectorCode)
            ?.manifest.commands.find((c) => c.requires === 'RECONCILIATION_READ');
          if (!command || !effectiveCapabilities(instance).includes('RECONCILIATION_READ'))
            throw new AppError('integration.reconciliation.unsupported', HttpStatus.CONFLICT);
          const actor = this.actors.get();
          const run = await this.runs.insertRun({
            id: newId(),
            tenantId: instance.tenantId,
            propertyId: instance.propertyId,
            instanceId: instance.id,
            requestedByType: actor?.type ?? 'SYSTEM',
            requestedById: actor?.id ?? null,
          });
          const requested = await this.integrations.requestCommand({
            tenantId: instance.tenantId,
            integrationInstanceId: instance.id,
            commandType: command.code,
            payload: {},
            idempotencyKey: `reconcile:${run.id}`,
            expiresAt: new Date(Date.now() + SNAPSHOT_TIMEOUT_MS),
            requestedBy: { type: actor?.type ?? 'SYSTEM', id: actor?.id ?? null },
          });
          const updated = await this.runs.updateRun(scope, run.id, { commandId: requested.id });
          await this.audit.record({
            action: 'integration.reconciliation.start',
            entityType: 'reconciliation_run',
            entityId: run.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { instanceId: instance.id, commandId: requested.id },
          });
          return updated;
        }),
    );
  }

  list(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.instance(scope, instanceId);
          return this.runs.runs(scope, instanceId);
        }),
    );
  }

  get(scope: PropertyScope, instanceId: string, runId: string) {
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.instance(scope, instanceId);
          const run = isUuid(runId) ? await this.runs.run(scope, runId) : undefined;
          if (!run || run.instanceId !== instanceId)
            throw AppError.notFound('integration.reconciliation.not_found');
          const results = await this.runs.results(scope, run.id);
          const entries = await this.runs.entries(scope, run.id);
          return { ...run, reportedInHouse: entries.length, results };
        }),
    );
  }

  /** Ingestion of database-sync records (inside the message's transaction). */
  async onSync(instance: IntegrationInstanceRow, record: SyncRecord, roomId: string | null) {
    const scope: TenantScope = { tenantId: instance.tenantId };
    switch (record.kind) {
      case 'SYNC_START': {
        // A snapshot the platform did not ask for (e.g. the PMS resyncs on link start) still gets a run.
        const run =
          (await this.runs.awaitingSnapshot(scope, instance.id)) ??
          (await this.runs.insertRun({
            id: newId(),
            tenantId: instance.tenantId,
            propertyId: instance.propertyId,
            instanceId: instance.id,
            requestedByType: 'INTEGRATION',
            requestedById: instance.id,
          }));
        await this.runs.clearEntries(scope, run.id);
        await this.runs.updateRun(scope, run.id, {
          snapshotStartedAt: new Date(record.occurred_at),
        });
        return;
      }
      case 'IN_HOUSE_ENTRY': {
        const run = await this.runs.collecting(scope, instance.id);
        if (!run) {
          this.logger.warn(
            { instance_id: instance.id },
            'in-house entry outside a database sync ignored',
          );
          return;
        }
        await this.runs.addEntry({
          id: newId(),
          tenantId: instance.tenantId,
          runId: run.id,
          externalId: record.reservation.external_id,
          roomCode: record.room_code,
          roomId,
        });
        return;
      }
      case 'SYNC_END': {
        const run = await this.runs.collecting(scope, instance.id);
        if (!run) return;
        await this.runs.updateRun(scope, run.id, {
          snapshotCompletedAt: new Date(record.occurred_at),
        });
        const entries = await this.runs.entries(scope, run.id);
        await this.events.publish(ReconciliationSnapshotCompleted, {
          tenantId: instance.tenantId,
          propertyId: instance.propertyId,
          source: 'integration',
          aggregate: { type: 'reconciliation_run', id: run.id },
          payload: { run_id: run.id, instance_id: instance.id, entries: entries.length },
        });
        return;
      }
    }
  }

  private async instance(scope: PropertyScope, id: string): Promise<IntegrationInstanceRow> {
    const row = isUuid(id) ? await this.repo.instance(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('integration.instance.not_found');
    return row;
  }
}
