import { Injectable } from '@nestjs/common';
import { newId } from '@hotella/platform-database';
import { CommsRepositories } from '../infrastructure/repositories';
import type { ChannelIdentityRow } from '../infrastructure/schema';

/**
 * Channel identities (Spec §18.3): which guest a contact point was last verified for. Identity is never
 * authorization — callers still need a live grant for anything about a stay.
 */
@Injectable()
export class ChannelIdentityService {
  constructor(private readonly repo: CommsRepositories) {}

  /** Records that an identifier was seen (inbound message, OTP request). */
  observe(
    tenantId: string,
    type: ChannelIdentityRow['channelType'],
    identifier: string,
    at: Date = new Date(),
  ): Promise<ChannelIdentityRow> {
    return this.repo.upsertIdentity({
      id: newId(),
      tenantId,
      channelType: type,
      identifierNormalized: identifier,
      lastSeenAt: at,
    });
  }

  /** Binds the identifier to the guest who just proved control of it (OTP, staff-assisted verification). */
  async verify(
    tenantId: string,
    type: ChannelIdentityRow['channelType'],
    identifier: string,
    guestId: string,
    at: Date = new Date(),
  ): Promise<ChannelIdentityRow> {
    const row = await this.observe(tenantId, type, identifier, at);
    return this.repo.updateIdentity({ tenantId }, row.id, { guestId, verifiedAt: at });
  }

  /** The verified identity for an identifier, if any. */
  async verified(
    tenantId: string,
    type: ChannelIdentityRow['channelType'],
    identifier: string,
  ): Promise<ChannelIdentityRow | null> {
    const row = await this.repo.identity({ tenantId }, type, identifier);
    return row?.guestId && row.verifiedAt ? row : null;
  }

  /** The guest's verified identity on a channel type (most recent first). */
  async verifiedOfGuest(
    tenantId: string,
    guestId: string,
    type: ChannelIdentityRow['channelType'],
  ): Promise<ChannelIdentityRow | null> {
    const rows = (await this.repo.identitiesOfGuest({ tenantId }, guestId))
      .filter((r) => r.channelType === type && r.verifiedAt)
      .sort((a, b) => b.verifiedAt!.getTime() - a.verifiedAt!.getTime());
    return rows[0] ?? null;
  }

  /** Anonymization of a guest removes their contact points. */
  forget(tenantId: string, guestId: string): Promise<number> {
    return this.repo.deleteIdentitiesOfGuest({ tenantId }, guestId);
  }
}
