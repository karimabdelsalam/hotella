import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  AiAdminService,
  createModelSchema,
  createProviderSchema,
  routingSchema,
  updateModelSchema,
  updateProviderSchema,
  usageQuerySchema,
} from '../application/admin.service';
import {
  ExecutionAuditService,
  executionsQuerySchema,
} from '../application/execution-audit.service';

class CreateProviderDto extends createZodDto(createProviderSchema) {}
class UpdateProviderDto extends createZodDto(updateProviderSchema) {}
class CreateModelDto extends createZodDto(createModelSchema) {}
class UpdateModelDto extends createZodDto(updateModelSchema) {}
class RoutingDto extends createZodDto(routingSchema) {}
class UsageQueryDto extends createZodDto(usageQuerySchema) {}
class ExecutionsQueryDto extends createZodDto(executionsQuerySchema) {}

/** AI providers, models and routing (ADR-0018). */
@Controller('ai')
export class AiAdminController {
  constructor(
    private readonly admin: AiAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private tenant(): string {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.tenant.not_found');
    return tenantId;
  }

  @Get('providers')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  providers() {
    return this.admin.listProviders();
  }

  @Post('providers')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  createProvider(@Body() body: CreateProviderDto) {
    return this.admin.createProvider(body);
  }

  @Patch('providers/:id')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  updateProvider(@Param('id') id: string, @Body() body: UpdateProviderDto) {
    return this.admin.updateProvider(id, body);
  }

  @Get('models')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  models() {
    return this.admin.listModels();
  }

  @Post('models')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  createModel(@Body() body: CreateModelDto) {
    return this.admin.createModel(body);
  }

  @Patch('models/:id')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  updateModel(@Param('id') id: string, @Body() body: UpdateModelDto) {
    return this.admin.updateModel(id, body);
  }

  @Put('routing-rules/platform')
  @RequirePermission('ai.provider.manage', { checkedBy: 'gate' })
  putPlatformRule(@Body() body: RoutingDto) {
    return this.admin.putPlatformRule(body);
  }

  @Get('routing-rules')
  @RequirePermission('ai.routing.manage', { checkedBy: 'gate' })
  rules() {
    return this.admin.listRules(this.tenant());
  }

  @Put('routing-rules')
  @RequirePermission('ai.routing.manage', { checkedBy: 'gate' })
  putRule(@Body() body: RoutingDto) {
    return this.admin.putTenantRule(this.tenant(), body);
  }

  @Get('usage')
  @RequirePermission('ai.usage.read', { checkedBy: 'gate' })
  usage(@Query() query: UsageQueryDto) {
    return this.admin.usage(this.tenant(), query.from);
  }
}

/** The execution record of a property (Spec §34): what the AI did, why, at what cost. */
@Controller('properties/:propertyId/ai')
@PropertyScoped({ from: 'param' })
export class AiExecutionsController {
  constructor(
    private readonly audit: ExecutionAuditService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('executions')
  @RequirePermission('ai.execution.read')
  list(@Param('propertyId') propertyId: string, @Query() query: ExecutionsQueryDto) {
    return this.audit.list(this.scope(propertyId), query);
  }

  @Get('executions/:id')
  @RequirePermission('ai.execution.read')
  detail(@Param('propertyId') propertyId: string, @Param('id') id: string) {
    return this.audit.detail(this.scope(propertyId), id);
  }

  @Get('agents')
  @RequirePermission('ai.execution.read')
  agents(@Param('propertyId') propertyId: string) {
    return this.audit.agentsList(this.scope(propertyId));
  }
}
