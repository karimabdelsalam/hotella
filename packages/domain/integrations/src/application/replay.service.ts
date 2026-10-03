import { Inject, Injectable } from '@nestjs/common';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import {
  DATABASE,
  type Database,
  type PropertyScope,
  withTransaction,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { IntegrationMessageRow } from '../infrastructure/schema';
import { IngestService } from './ingest.service';

const REPLAYABLE: ReadonlySet<IntegrationMessageRow['status']> = new Set([
  'RECEIVED',
  'PENDING_MAPPING',
  'HELD',
  'FAILED',
  'REJECTED',
]);

/** Staff-triggered replays of parked messages (Spec §50 replay safety), gated and audited. */
@Injectable()
export class ReplayService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: IntegrationRepositories,
    private readonly ingest: IngestService,
    private readonly audit: AuditWriter,
    private readonly gate: ActionGate,
  ) {}

  /** Re-runs a parked message after its cause was fixed (mapping confirmed, adapter fixed, capability enabled). */
  async replay(scope: PropertyScope, instanceId: string, messageId: string) {
    return this.gate.execute(
      { action: 'integration.replay', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const message = await this.loadMessage(scope, instanceId, messageId);
        if (!REPLAYABLE.has(message.status))
          throw AppError.conflict('integration.message.not_replayable', {
            status: message.status,
          });
        const status = await this.ingest.reprocess(scope, message.id);
        await withTransaction(
          this.db,
          () =>
            this.audit.record({
              action: 'integration.message.replay',
              entityType: 'integration_message',
              entityId: message.id,
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              before: { status: message.status },
              after: { status },
            }),
          { tenantId: scope.tenantId },
        );
        return { messageId: message.id, status };
      },
    );
  }

  /** Replays every message waiting for a mapping, oldest first (after a batch of mappings was confirmed). */
  async replayPending(scope: PropertyScope, instanceId: string) {
    return this.gate.execute(
      { action: 'integration.replay', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        await this.instanceInProperty(scope, instanceId);
        const pending = await this.repo.pendingMappingMessages(scope, instanceId);
        const outcome: Record<string, number> = {};
        for (const m of pending) {
          const status = await this.ingest.reprocess(scope, m.id);
          outcome[status] = (outcome[status] ?? 0) + 1;
        }
        if (pending.length > 0)
          await withTransaction(
            this.db,
            () =>
              this.audit.record({
                action: 'integration.message.replay_pending',
                entityType: 'integration_instance',
                entityId: instanceId,
                tenantId: scope.tenantId,
                propertyId: scope.propertyId,
                after: { replayed: pending.length, outcome },
              }),
            { tenantId: scope.tenantId },
          );
        return { replayed: pending.length, outcome };
      },
    );
  }

  private async instanceInProperty(scope: PropertyScope, instanceId: string) {
    const instance = await this.repo.instance(scope, instanceId);
    if (!instance || instance.propertyId !== scope.propertyId)
      throw AppError.notFound('integration.instance.not_found');
    return instance;
  }

  private async loadMessage(scope: PropertyScope, instanceId: string, messageId: string) {
    await this.instanceInProperty(scope, instanceId);
    const m = await withTransaction(this.db, () => this.repo.messageForUpdate(scope, messageId), {
      tenantId: scope.tenantId,
    });
    if (!m || m.instanceId !== instanceId) throw AppError.notFound('integration.message.not_found');
    return m;
  }
}
