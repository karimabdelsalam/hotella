import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { uuidSchema } from '@hotella/contracts-api';
import { RequirePermission } from '@hotella/platform-auth';
import { CurrentLocale, I18nService } from '@hotella/platform-i18n';
import { ConfigurationService } from './configuration.service';
import { SettingsRegistry } from './registry';
import { RetentionPolicyService } from './retention.service';

const keyParam = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
const scope = z.enum(['PLATFORM', 'TENANT', 'PROPERTY']);
const targetSchema = z.object({
  scope,
  tenantId: uuidSchema.nullish(),
  propertyId: uuidSchema.nullish(),
});
class EffectiveQueryDto extends createZodDto(
  z.object({ tenantId: uuidSchema.optional(), propertyId: uuidSchema.optional() }),
) {}
class TargetQueryDto extends createZodDto(
  targetSchema.extend({ reason: z.string().max(500).optional() }),
) {}
class SetValueDto extends createZodDto(
  targetSchema.extend({
    value: z.unknown(),
    /** Optimistic concurrency: the version you read (0 when no value is stored at this scope yet). */
    version: z.number().int().min(0).optional(),
    reason: z.string().max(500).nullish(),
  }),
) {}
class RetentionDto extends createZodDto(
  z.object({
    scope: z.enum(['PLATFORM', 'TENANT']),
    tenantId: uuidSchema.nullish(),
    dataClass: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SENSITIVE', 'RESTRICTED']),
    entityType: z
      .string()
      .regex(/^[a-z][a-z0-9_.]{1,63}$/)
      .nullish(),
    retainDays: z.number().int().min(1).max(36_500),
    action: z.enum(['DELETE', 'ANONYMIZE', 'ARCHIVE']),
    legalHold: z.boolean().default(false),
    reason: z.string().max(500).nullish(),
  }),
) {}
class TenantQueryDto extends createZodDto(z.object({ tenantId: uuidSchema.optional() })) {}

/**
 * Configuration API (Spec §72). Scope checks need the scope from the body/query (PLATFORM is admin-only, PROPERTY
 * needs the property), so permissions are declared here and enforced by the service's ActionGate.
 */
@Controller('config')
export class ConfigurationController {
  constructor(
    private readonly config: ConfigurationService,
    private readonly registry: SettingsRegistry,
    private readonly i18n: I18nService,
    private readonly locale: CurrentLocale,
  ) {}

  @Get('definitions')
  @RequirePermission('config.read', { checkedBy: 'gate' })
  definitions() {
    const locale = this.locale.get();
    return this.registry.all().map((d) => ({
      key: d.key,
      scopes: d.scopes,
      default: d.default,
      description: this.i18n.has(d.descriptionKey, locale)
        ? this.i18n.t(d.descriptionKey, {}, locale)
        : d.key,
    }));
  }

  @Get('values')
  @RequirePermission('config.read', { checkedBy: 'gate' })
  listAt(@Query() q: TargetQueryDto) {
    return this.config.listAt(q);
  }

  @Get('effective/:key')
  @RequirePermission('config.read', { checkedBy: 'gate' })
  effective(@Param('key') key: string, @Query() q: EffectiveQueryDto) {
    return this.config.effectiveFor(keyParam.parse(key), q);
  }

  @Put('values/:key')
  @RequirePermission('config.manage', { checkedBy: 'gate' })
  set(@Param('key') key: string, @Body() body: SetValueDto) {
    return this.config.set(keyParam.parse(key), body, body.value, {
      ...(body.version !== undefined ? { expectedVersion: body.version } : {}),
      reason: body.reason ?? null,
    });
  }

  @Delete('values/:key')
  @RequirePermission('config.manage', { checkedBy: 'gate' })
  remove(@Param('key') key: string, @Query() q: TargetQueryDto) {
    return this.config.remove(keyParam.parse(key), q, { reason: q.reason ?? null });
  }
}

@Controller('retention-policies')
export class RetentionPoliciesController {
  constructor(private readonly retention: RetentionPolicyService) {}

  @Get()
  @RequirePermission('config.read', { checkedBy: 'gate' })
  list(@Query() q: TenantQueryDto) {
    return this.retention.list(q.tenantId ?? null);
  }

  @Put()
  @RequirePermission('config.manage', { checkedBy: 'gate' })
  upsert(@Body() body: RetentionDto) {
    return this.retention.upsert(body);
  }
}
