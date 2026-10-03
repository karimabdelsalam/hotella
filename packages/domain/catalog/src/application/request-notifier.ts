import { Inject, Injectable } from '@nestjs/common';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
} from '@hotella/domain-communications/public';
import { I18nService } from '@hotella/platform-i18n';
import { SettingsReader } from '@hotella/platform-settings';
import { CATALOG_NOTIFY_STATUSES } from '../domain/settings';
import type { RequestRow } from '../infrastructure/schema';
import { CatalogReader } from './catalog-reader';

/** WhatsApp template for request updates (ADR-0015): parameters are the service name and the new status. */
export const SERVICE_UPDATE_TEMPLATE = 'service_update';

/**
 * Tells the guest when their request moves on (Spec §25), in the language they asked in, through the Conversation
 * Engine (rule 18). Statuses come from `catalog.notify.statuses`; a guest is not told about what they did themselves.
 */
@Injectable()
export class RequestNotifier {
  constructor(
    private readonly settings: SettingsReader,
    private readonly reader: CatalogReader,
    private readonly i18n: I18nService,
    @Inject(COMMUNICATIONS_API) private readonly comms: CommunicationsPublicApi,
  ) {}

  async statusChanged(request: RequestRow, actorType: string): Promise<void> {
    if (actorType === 'GUEST') return;
    const at = { tenantId: request.tenantId, propertyId: request.propertyId };
    const statuses: readonly string[] = await this.settings.value(CATALOG_NOTIFY_STATUSES, at);
    if (!statuses.includes(request.status)) return;
    const status = request.status.toLowerCase();
    const service = await this.reader.serviceName(at, request.serviceVersionId, request.locale);
    await this.comms.notifyGuest({
      ...at,
      stayId: request.stayId,
      guestId: request.guestId,
      locale: request.locale,
      message: { key: `catalog.notification.request_${status}`, params: { service } },
      template: {
        code: SERVICE_UPDATE_TEMPLATE,
        parameters: [
          service,
          this.i18n.t(`catalog.notification.status.${status}`, {}, request.locale),
        ],
      },
      source: 'catalog',
    });
  }
}
