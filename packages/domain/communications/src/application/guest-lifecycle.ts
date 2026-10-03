import { Injectable } from '@nestjs/common';
import { type EventEnvelope, GuestAnonymized } from '@hotella/contracts-events';
import { ChannelIdentityService } from './identity.service';

/** Follows the guest context: an anonymized guest's contact points are removed (Spec §69, CLAUDE.md rule 21). */
@Injectable()
export class GuestLifecycleConsumer {
  constructor(private readonly identities: ChannelIdentityService) {}

  static readonly consumes = [GuestAnonymized] as const;

  async apply(envelope: EventEnvelope): Promise<void> {
    if (envelope.event_type !== GuestAnonymized.type || !envelope.tenant_id) return;
    const e = GuestAnonymized.parse(envelope);
    await this.identities.forget(envelope.tenant_id, e.payload.guest_id);
  }
}
