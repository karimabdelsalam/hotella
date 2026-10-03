import { Inject, Injectable } from '@nestjs/common';
import {
  type EventEnvelope,
  RoomReady,
  WorkItemCreated,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { SettingsReader } from '@hotella/platform-settings';
import { evaluateReadiness, type Readiness } from '../domain/readiness';
import { HK_READINESS_DIMENSIONS } from '../domain/settings';
import { HousekeepingRepositories } from '../infrastructure/repositories';
import type { RoomStateRow } from '../infrastructure/schema';

const ENGINEERING = 'ENG';

/**
 * Room readiness v0 (Spec §16, BUILD_PLAN 7.B). Recomputed whenever the room's state moves and when engineering work at
 * the room opens or closes; a room that becomes ready announces `hk.room.ready.v1`.
 */
@Injectable()
export class ReadinessService {
  /** Engineering work at a room changes its readiness (worker consumer). */
  static readonly consumes = [WorkItemCreated, WorkItemStatusChanged];

  constructor(
    private readonly repo: HousekeepingRepositories,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly settings: SettingsReader,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
  ) {}

  /** The room's readiness right now, dimension by dimension. */
  async evaluate(scope: PropertyScope, state: RoomStateRow): Promise<Readiness> {
    const dimensions = await this.settings.value(HK_READINESS_DIMENSIONS, scope);
    let openEngineeringWork: number | null = null;
    if (dimensions.includes('ENGINEERING')) {
      try {
        openEngineeringWork = (
          await this.ops.openWorkItemsAtLocation(scope.tenantId, scope.propertyId, state.roomId)
        ).filter((w) => w.departmentCode === ENGINEERING).length;
      } catch {
        openEngineeringWork = null;
      }
    }
    return evaluateReadiness(dimensions, {
      occupancy: state.occupancy,
      housekeeping: state.housekeeping,
      frontOffice: state.frontOffice,
      openEngineeringWork,
    });
  }

  /** Stores the readiness of a locked room row (inside the caller's transaction) and announces a room becoming ready. */
  async refresh(scope: PropertyScope, state: RoomStateRow, at: Date): Promise<RoomStateRow> {
    const readiness = await this.evaluate(scope, state);
    if (readiness.ready === state.ready) return state;
    const updated = await this.repo.updateState(scope, state.roomId, {
      ready: readiness.ready,
      readySince: readiness.ready ? at : null,
    });
    if (readiness.ready)
      await this.events.publish(RoomReady, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'hk',
        aggregate: { type: 'room', id: state.roomId },
        payload: {
          room_id: state.roomId,
          dimensions: readiness.dimensions.map((d) => d.dimension),
        },
      });
    return updated;
  }

  /** Engineering work opened or closed at a room the platform tracks. */
  async apply(envelope: EventEnvelope): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId) return;
    const workItemId = (envelope.payload as { work_item_id?: string }).work_item_id;
    if (!workItemId) return;
    const work = await this.ops.getWorkItem(tenantId, workItemId);
    if (!work || work.departmentCode !== ENGINEERING || !work.locationId) return;
    const scope = { tenantId, propertyId };
    const roomId = work.locationId;
    await this.tx.run(async () => {
      if (!(await this.repo.state({ tenantId }, roomId))) return;
      await this.refresh(scope, await this.repo.stateForUpdate(scope, roomId), new Date());
    });
  }
}
