import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '@hotella/platform-database';
import { HousekeepingRepositories } from '../infrastructure/repositories';
import type { HousekeepingPublicApi, RoomStateSummary } from '../public';
import { RoomStateService } from './room-state.service';

@Injectable()
export class HousekeepingPublicApiService implements HousekeepingPublicApi {
  constructor(
    private readonly repo: HousekeepingRepositories,
    private readonly rooms: RoomStateService,
    private readonly tx: TransactionRunner,
  ) {}

  roomState(
    tenantId: string,
    propertyId: string,
    roomId: string,
  ): Promise<RoomStateSummary | null> {
    return this.tx.read(async () => {
      const s = await this.repo.state({ tenantId }, roomId);
      if (!s || s.propertyId !== propertyId) return null;
      const signals = (await this.repo.openSignals({ tenantId, propertyId }))
        .filter((x) => x.roomId === roomId)
        .map((x) => x.signal);
      return {
        roomId: s.roomId,
        occupancy: s.occupancy,
        housekeeping: s.housekeeping,
        frontOffice: s.frontOffice,
        lastCleanedAt: s.lastCleanedAt?.toISOString() ?? null,
        lastInspectedAt: s.lastInspectedAt?.toISOString() ?? null,
        signals,
      };
    });
  }

  setGuestRoomSignal(input: Parameters<HousekeepingPublicApi['setGuestRoomSignal']>[0]) {
    return this.rooms.signal(
      { tenantId: input.tenantId, propertyId: input.propertyId },
      input.roomId,
      { signal: input.signal, active: input.active },
      'GUEST_PORTAL',
      input.actor,
    );
  }
}
