import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { RequestActor } from '@hotella/platform-auth';
import { AuditWriter } from '@hotella/platform-audit';
import { isUuid, newId, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { StaffDeviceRow } from '../infrastructure/schema';

export const registerDeviceSchema = z.object({
  platform: z.enum(['ANDROID', 'IOS']),
  /** The push provider's registration token (FCM). Opaque; never logged or audited. */
  pushToken: z.string().trim().min(20).max(4096),
  appVersion: z.string().trim().max(32).optional(),
  locale: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

/**
 * The phones a staff member uses the Hotella app on (ADR-0023). A device belongs to the session that registered it:
 * signing out or disabling the person revokes it. The same token registered again (the same phone) moves to the
 * person now signed in on it; nothing about the token is written to logs or the audit trail.
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  register(actor: RequestActor, input: RegisterDeviceInput) {
    const { tenantId, sessionId } = this.staff(actor);
    return this.tx.run(async () => {
      const now = new Date();
      let device: StaffDeviceRow | undefined;
      for (const live of await this.repo.liveDevicesWithToken(tenantId, input.pushToken)) {
        if (live.userId === actor.id && !device)
          device = await this.repo.touchDevice(
            live.id,
            {
              sessionId,
              platform: input.platform,
              appVersion: input.appVersion ?? live.appVersion,
              locale: input.locale ?? live.locale,
            },
            now,
          );
        else await this.repo.revokeDevices({ id: live.id }, 'REASSIGNED', now);
      }
      if (!device) {
        device = await this.repo.insertDevice({
          id: newId(),
          tenantId,
          userId: actor.id,
          sessionId,
          platform: input.platform,
          pushToken: input.pushToken,
          appVersion: input.appVersion ?? null,
          locale: input.locale ?? null,
          lastSeenAt: now,
        });
        await this.audit.record({
          action: 'iam.device.register',
          entityType: 'staff_device',
          entityId: device.id,
          tenantId,
          propertyId: null,
          after: { platform: device.platform, appVersion: device.appVersion },
        });
      }
      return view(device);
    });
  }

  unregister(actor: RequestActor, id: string) {
    const { tenantId } = this.staff(actor);
    return this.tx.run(async () => {
      const n = isUuid(id)
        ? await this.repo.revokeDevices({ id, userId: actor.id }, 'SIGNED_OUT', new Date())
        : 0;
      if (n === 0) throw AppError.notFound('iam.device.not_found');
      await this.audit.record({
        action: 'iam.device.revoke',
        entityType: 'staff_device',
        entityId: id,
        tenantId,
        propertyId: null,
        reason: 'SIGNED_OUT',
      });
    });
  }

  private staff(actor: RequestActor): { tenantId: string; sessionId: string } {
    if (actor.type !== 'USER' || !actor.tenantId || !actor.sessionId)
      throw new AppError('iam.device.staff_only', HttpStatus.FORBIDDEN);
    return { tenantId: actor.tenantId, sessionId: actor.sessionId };
  }
}

function view(d: StaffDeviceRow) {
  return {
    id: d.id,
    platform: d.platform,
    appVersion: d.appVersion,
    locale: d.locale,
    createdAt: d.createdAt,
  };
}
