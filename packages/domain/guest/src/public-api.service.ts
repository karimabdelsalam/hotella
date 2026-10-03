import { Injectable } from '@nestjs/common';
import { GuestAccessService } from './application/access.service';
import { GuestRepositories } from './infrastructure/repositories';
import type { StayRow } from './infrastructure/schema';
import type {
  GrantSummary,
  GuestPrincipal,
  GuestPublicApi,
  IssueGrantInput,
  OpenedGuestSession,
  StaySummary,
} from './public';

@Injectable()
export class GuestPublicApiService implements GuestPublicApi {
  constructor(
    private readonly repo: GuestRepositories,
    private readonly access: GuestAccessService,
  ) {}

  async getStay(tenantId: string, stayId: string): Promise<StaySummary | null> {
    const stay = await this.repo.stay({ tenantId }, stayId);
    return stay ? this.summary(tenantId, stay) : null;
  }

  async inHouseStaysInRoom(
    tenantId: string,
    propertyId: string,
    roomId: string,
  ): Promise<readonly StaySummary[]> {
    const stays = await this.repo.inHouseStaysInRoom({ tenantId, propertyId }, roomId);
    const out: StaySummary[] = [];
    for (const s of stays) out.push(await this.summary(tenantId, s));
    return out;
  }

  issueGrant(input: IssueGrantInput): Promise<GrantSummary> {
    return this.access.issueGrant(input);
  }
  openGuestSession(
    tenantId: string,
    grantId: string,
    deviceInfo: string | null,
  ): Promise<OpenedGuestSession> {
    return this.access.openSession(tenantId, grantId, deviceInfo);
  }
  authenticateGuestSession(token: string): Promise<GuestPrincipal | null> {
    return this.access.authenticate(token);
  }
  revokeGuestSession(tenantId: string, sessionId: string, reason: string): Promise<boolean> {
    return this.access.revokeSession(tenantId, sessionId, reason);
  }
  liveGrantAtProperty(
    tenantId: string,
    propertyId: string,
    guestId: string,
  ): Promise<GrantSummary | null> {
    return this.access.liveGrantAtProperty(tenantId, propertyId, guestId);
  }

  private async summary(tenantId: string, s: StayRow): Promise<StaySummary> {
    const open = await this.repo.openAssignment({ tenantId }, s.id);
    const party = await this.repo.activeParty({ tenantId }, s.id);
    return {
      id: s.id,
      propertyId: s.propertyId,
      status: s.status,
      primaryGuestId: s.primaryGuestId,
      expectedArrival: s.expectedArrival,
      expectedDeparture: s.expectedDeparture,
      currentRoomId: open?.roomId ?? null,
      partyGuestIds: [...party]
        .sort((a, b) => (a.role === 'PRIMARY' ? -1 : b.role === 'PRIMARY' ? 1 : 0))
        .map((m) => m.guestId),
    };
  }
}
