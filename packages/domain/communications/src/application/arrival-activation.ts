import { Inject, Injectable } from '@nestjs/common';
import { type EventEnvelope, StayStatusChanged } from '@hotella/contracts-events';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { CommsRepositories } from '../infrastructure/repositories';
import { ActivationService } from './activation.service';
import { ChannelRuntime } from './channel.service';
import { ChannelIdentityService } from './identity.service';
import { ProviderError } from './providers';

/**
 * Primary activation on arrival (Spec §19.1): when a stay goes in house and its primary guest already proved a
 * WhatsApp number at this tenant, the platform mints a link and sends the activation template. Otherwise front desk
 * issues the link on demand (no message is ever sent to an unverified number).
 */
@Injectable()
export class ArrivalActivation {
  constructor(
    private readonly activation: ActivationService,
    private readonly identities: ChannelIdentityService,
    private readonly comms: CommsRepositories,
    private readonly runtime: ChannelRuntime,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  static readonly consumes = [StayStatusChanged] as const;

  async apply(envelope: EventEnvelope): Promise<void> {
    if (
      envelope.event_type !== StayStatusChanged.type ||
      !envelope.tenant_id ||
      !envelope.property_id
    )
      return;
    const e = StayStatusChanged.parse(envelope);
    if (e.payload.to !== 'IN_HOUSE' || e.payload.from !== 'EXPECTED') return;
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    const identity = await this.identities.verifiedOfGuest(
      tenantId,
      e.payload.primary_guest_id,
      'WHATSAPP',
    );
    if (!identity) return;
    const channel = (await this.comms.activeChannels({ tenantId, propertyId }, 'WHATSAPP'))[0];
    if (!channel || channel.health === 'OFFLINE' || channel.health === 'AUTH_FAILED') return;
    const party = await this.guests.stayParty(tenantId, e.payload.stay_id);
    const primary = party.find((m) => m.guestId === e.payload.primary_guest_id);
    const issued = await this.activation.issueToken({
      tenantId,
      propertyId,
      stayId: e.payload.stay_id,
      guestId: e.payload.primary_guest_id,
      deliveredVia: 'WHATSAPP',
      actor: { type: 'SYSTEM', id: null },
    });
    const adapter = this.runtime.adapterFor(channel);
    if (adapter.kind !== 'MESSAGING') return;
    try {
      await adapter.sendTemplate(this.runtime.context(channel), {
        to: identity.identifierNormalized,
        template: 'activation',
        locale: primary?.primaryLocale ?? 'en',
        parameters: [primary?.givenName ?? '', issued.url],
      });
    } catch (err) {
      // Front desk can still issue the link; a retry would only mint another one.
      const code = err instanceof ProviderError ? err.code : 'ERROR';
      this.logger.warn(
        { stay_id: e.payload.stay_id, channel_id: channel.id, error_code: code },
        'activation link not sent',
      );
      return;
    }
    this.logger.info(
      { stay_id: e.payload.stay_id, channel_id: channel.id },
      'activation link sent on arrival',
    );
  }
}
