import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { from, type Observable, switchMap } from 'rxjs';
import { AuditWriter } from '@hotella/platform-audit';
import { ActorStore } from '@hotella/platform-auth';
import { RequestContext } from '@hotella/platform-observability';

/**
 * Spec §64 "audited": every request a support engineer makes — reads included — leaves an audit row naming the
 * route, the tenant/property scope and the correlation id, written before the handler runs.
 */
@Injectable()
export class SupportAccessAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly actors: ActorStore,
    private readonly audit: AuditWriter,
    private readonly ctx: RequestContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const actor = this.actors.get();
    if (context.getType() !== 'http' || actor?.type !== 'SUPPORT') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    return from(
      this.audit.record({
        action: 'support.access.use',
        entityType: 'http_route',
        entityId: route.slice(0, 128),
        tenantId: this.ctx.tenantId,
        propertyId: this.ctx.propertyId,
        allowAutocommit: true,
      }),
    ).pipe(switchMap(() => next.handle()));
  }
}
