import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, like, lt, or, type SQL } from 'drizzle-orm';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  buildPage,
  cursorQuerySchema,
  decodeCursor,
  type Page,
  uuidSchema,
} from '@hotella/contracts-api';
import {
  ActorStore,
  PropertyScoped,
  RequirePermission,
  TenantScoped,
} from '@hotella/platform-auth';
import { DATABASE, type Database } from '@hotella/platform-database';
import { auditLog, type AuditRow } from './schema/audit';

const auditQuerySchema = cursorQuerySchema.extend({
  /** Platform staff (with an approved support grant) name the tenant; tenant users may omit it. */
  tenantId: uuidSchema.optional(),
  propertyId: uuidSchema.optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(128).optional(),
  /** Exact action or a prefix ending with `.`, e.g. `iam.` or `org.property.`. */
  action: z.string().min(2).max(128).optional(),
});
class AuditQueryDto extends createZodDto(auditQuerySchema) {}
const cursorShape = z.object({ t: z.string(), id: z.string() });

@Controller('audit')
export class AuditController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly actors: ActorStore,
  ) {}

  /** Read-only audit trail for one tenant, optionally one property / entity / action family (newest first). */
  @Get()
  @TenantScoped({ from: 'query', optional: true })
  @PropertyScoped({ from: 'query', optional: true })
  @RequirePermission('audit.read')
  async list(@Query() q: AuditQueryDto): Promise<Page<AuditRow>> {
    const tenantId = q.tenantId ?? this.actors.require().tenantId!;
    const filters: SQL[] = [eq(auditLog.tenantId, tenantId)];
    if (q.propertyId) filters.push(eq(auditLog.propertyId, q.propertyId));
    if (q.entityType) filters.push(eq(auditLog.entityType, q.entityType));
    if (q.entityId) filters.push(eq(auditLog.entityId, q.entityId));
    if (q.action)
      filters.push(
        q.action.endsWith('.')
          ? like(auditLog.action, `${q.action}%`)
          : eq(auditLog.action, q.action),
      );
    const cursor = decodeCursor(q.cursor, cursorShape);
    if (cursor) {
      const at = new Date(cursor.t);
      filters.push(
        or(
          lt(auditLog.occurredAt, at),
          and(eq(auditLog.occurredAt, at), lt(auditLog.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...filters))
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(q.limit + 1);
    return buildPage(rows, q.limit, (last) => ({ t: last.occurredAt.toISOString(), id: last.id }));
  }
}
