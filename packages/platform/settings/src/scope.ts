import { HttpStatus } from '@nestjs/common';
import type { RequestActor } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';

/** Tenant users act on their own tenant (naming another → 404); platform staff must name one. */
export function actingTenant(actor: RequestActor, named?: string | null): string {
  if (actor.tenantId) {
    if (named && named !== actor.tenantId) throw AppError.notFound();
    return actor.tenantId;
  }
  if (!named)
    throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
  return named;
}
