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
import type { PmsReservationRow } from '@hotella/contracts-connectors';
import { ConnectorRegistry } from '../connectors/registry';
import { AgentQueryService } from './agent-query.service';
import { effectiveCapabilities } from '../domain/instance';
import type { SyncRecord } from '../domain/mapping';
import { ReconciliationRepositories } from '../infrastructure/reconciliation-repositories';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { IntegrationInstanceRow } from '../infrastructure/schema';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '../public';

/** The predefined read that answers the in-house list (OPERA database, simulator). */
const IN_HOUSE_QUERY = 'IN_HOUSE';

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
    private readonly agentQueries: AgentQueryService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  start(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.reconcile', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const { run, instance, viaQuery } = await this.tx.run(async () => {
          const instance = await this.instance(scope, instanceId);
          const manifest = this.connectors.get(instance.connectorCode)?.manifest;
          if (!effectiveCapabilities(instance).includes('RECONCILIATION_READ'))
            throw new AppError('integration.reconciliation.unsupported', HttpStatus.CONFLICT);
          // A connector that answers the in-house snapshot as a read (the OPERA database, ADR-0019 guide §6.5) is
          // preferred: it does not interrupt IFC8. Otherwise — or while its agent speaks only link protocol 1 — the
          // PMS is asked for a database swap (command).
          const command = manifest?.commands.find((c) => c.requires === 'RECONCILIATION_READ');
          const viaQuery =
            Boolean(manifest?.queries?.some((q) => q.code === IN_HOUSE_QUERY)) &&
            (!command || (await this.agentQueries.reachable(scope, instance.id)));
          if (!viaQuery && !command)
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
          let commandId: string | null = null;
          if (!viaQuery) {
            const requested = await this.integrations.requestCommand({
              tenantId: instance.tenantId,
              integrationInstanceId: instance.id,
              commandType: command!.code,
              payload: {},
              idempotencyKey: `reconcile:${run.id}`,
              expiresAt: new Date(Date.now() + SNAPSHOT_TIMEOUT_MS),
              requestedBy: { type: actor?.type ?? 'SYSTEM', id: actor?.id ?? null },
            });
            commandId = requested.id;
          }
          const updated = commandId ? await this.runs.updateRun(scope, run.id, { commandId }) : run;
          await this.audit.record({
            action: 'integration.reconciliation.start',
            entityType: 'reconciliation_run',
            entityId: run.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { instanceId: instance.id, commandId, via: viaQuery ? 'QUERY' : 'COMMAND' },
          });
          return { run: updated!, instance, viaQuery };
        });
        if (!viaQuery) return run;
        await this.snapshotByQuery(scope, instance, run.id);
        return (await this.tx.read(() => this.runs.run(scope, run.id)))!;
      },
    );
  }

  /** The in-house list as a predefined read (link protocol 2), recorded like a database swap. */
  private async snapshotByQuery(
    scope: PropertyScope,
    instance: IntegrationInstanceRow,
    runId: string,
  ): Promise<void> {
    const actor = this.actors.get();
    const startedAt = new Date();
    const outcome = await this.agentQueries.run({
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      instanceId: instance.id,
      connectorCode: instance.connectorCode,
      queryType: IN_HOUSE_QUERY,
      params: {},
      deadlineMs: 30_000,
      requestedBy: { type: actor?.type ?? 'SYSTEM', id: actor?.id ?? null },
      routing: { operation: 'RECONCILIATION_SNAPSHOT', chosen: instance.connectorCode },
    });
    await this.tx.run(async () => {
      if (outcome.status !== 'OK') {
        this.logger.warn(
          { run_id: runId, instance_id: instance.id, status: outcome.status },
          'reconciliation snapshot query did not answer',
        );
        await this.runs.updateRun(scope, runId, { status: 'FAILED', completedAt: new Date() });
        return;
      }
      await this.runs.clearEntries(scope, runId);
      await this.runs.updateRun(scope, runId, { snapshotStartedAt: startedAt });
      const rows = (outcome.rows as PmsReservationRow[]).filter((r) => r.status === 'IN_HOUSE');
      for (const r of rows) {
        const mapping = r.room_number
          ? await this.repo.mapping(scope, instance.id, 'ROOM', r.room_number)
          : undefined;
        await this.runs.addEntry({
          id: newId(),
          tenantId: instance.tenantId,
          runId,
          externalId: r.reservation_id,
          roomCode: r.room_number,
          roomId: mapping?.internalValue ?? null,
        });
      }
      await this.runs.updateRun(scope, runId, { snapshotCompletedAt: new Date() });
      await this.events.publish(ReconciliationSnapshotCompleted, {
        tenantId: instance.tenantId,
        propertyId: instance.propertyId,
        source: 'integration',
        aggregate: { type: 'reconciliation_run', id: runId },
        payload: { run_id: runId, instance_id: instance.id, entries: rows.length },
      });
    });
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
