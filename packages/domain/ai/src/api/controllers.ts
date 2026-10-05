import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
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
  createCaseSchema,
  createSetSchema,
  EvaluationService,
  publishSchema,
  releaseSchema,
  rollbackSchema,
  startEvaluationSchema,
  updateSetSchema,
} from '../application/evaluation.service';
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
class CreateEvaluationSetDto extends createZodDto(createSetSchema) {}
class UpdateEvaluationSetDto extends createZodDto(updateSetSchema) {}
class CreateEvaluationCaseDto extends createZodDto(createCaseSchema) {}
class StartEvaluationDto extends createZodDto(startEvaluationSchema) {}
class PublishAgentVersionDto extends createZodDto(publishSchema) {}
class ReleaseAgentDto extends createZodDto(releaseSchema) {}
class RollbackAgentDto extends createZodDto(rollbackSchema) {}

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

/**
 * Agent evaluation and release (Spec §40, BUILD_PLAN 12.1): evaluation sets and cases, regression runs of a version,
 * and the release of a candidate version once its runs passed. Platform callers manage platform sets and releases;
 * a tenant manages its own sets and runs them on its properties.
 */
@Controller('ai')
export class AiEvaluationController {
  constructor(private readonly evaluation: EvaluationService) {}

  @Get('evaluation-sets')
  @RequirePermission('ai.evaluation.read', { checkedBy: 'gate' })
  sets(@Query('agentCode') agentCode?: string) {
    return this.evaluation.listSets(agentCode);
  }

  @Post('evaluation-sets')
  @RequirePermission('ai.evaluation.manage', { checkedBy: 'gate' })
  createSet(@Body() body: CreateEvaluationSetDto) {
    return this.evaluation.createSet(body);
  }

  @Get('evaluation-sets/:id')
  @RequirePermission('ai.evaluation.read', { checkedBy: 'gate' })
  set(@Param('id') id: string) {
    return this.evaluation.getSet(id);
  }

  @Patch('evaluation-sets/:id')
  @RequirePermission('ai.evaluation.manage', { checkedBy: 'gate' })
  updateSet(@Param('id') id: string, @Body() body: UpdateEvaluationSetDto) {
    return this.evaluation.updateSet(id, body);
  }

  @Post('evaluation-sets/:id/cases')
  @RequirePermission('ai.evaluation.manage', { checkedBy: 'gate' })
  addCase(@Param('id') id: string, @Body() body: CreateEvaluationCaseDto) {
    return this.evaluation.addCase(id, body);
  }

  @Delete('evaluation-sets/:id/cases/:caseId')
  @HttpCode(204)
  @RequirePermission('ai.evaluation.manage', { checkedBy: 'gate' })
  async retireCase(@Param('id') id: string, @Param('caseId') caseId: string) {
    await this.evaluation.retireCase(id, caseId);
  }

  @Get('agents/:code/versions')
  @RequirePermission('ai.evaluation.read', { checkedBy: 'gate' })
  versions(@Param('code') code: string) {
    return this.evaluation.versions(code);
  }

  @Post('agents/:code/versions/:versionId/evaluations')
  @RequirePermission('ai.evaluation.manage', { checkedBy: 'gate' })
  evaluate(
    @Param('code') code: string,
    @Param('versionId') versionId: string,
    @Body() body: StartEvaluationDto,
  ) {
    return this.evaluation.start(code, versionId, body);
  }

  @Get('evaluation-runs/:id')
  @RequirePermission('ai.evaluation.read', { checkedBy: 'gate' })
  run(@Param('id') id: string) {
    return this.evaluation.getRun(id);
  }

  @Post('agents/:code/versions/:versionId/publish')
  @HttpCode(200)
  @RequirePermission('ai.agent.release', { checkedBy: 'gate' })
  publish(
    @Param('code') code: string,
    @Param('versionId') versionId: string,
    @Body() body: PublishAgentVersionDto,
  ) {
    return this.evaluation.publish(code, versionId, body);
  }

  @Get('agents/:code/releases')
  @RequirePermission('ai.evaluation.read', { checkedBy: 'gate' })
  releases(@Param('code') code: string) {
    return this.evaluation.releases(code);
  }

  /** SHADOW (beside the active version, never acting), CANARY (a share of conversations) or ACTIVE (BUILD_PLAN 12.2). */
  @Post('agents/:code/releases')
  @RequirePermission('ai.agent.release', { checkedBy: 'gate' })
  release(@Param('code') code: string, @Body() body: ReleaseAgentDto) {
    return this.evaluation.release(code, body);
  }

  /** Ends a shadow or canary trial; otherwise puts the version the last release replaced back. */
  @Post('agents/:code/rollback')
  @HttpCode(200)
  @RequirePermission('ai.agent.release', { checkedBy: 'gate' })
  rollback(@Param('code') code: string, @Body() body: RollbackAgentDto) {
    return this.evaluation.rollback(code, body);
  }

  @Get('agents/:code/versions/:versionId/runs')
  @RequirePermission('ai.evaluation.read', { checkedBy: 'gate' })
  runs(@Param('code') code: string, @Param('versionId') versionId: string) {
    return this.evaluation.runsOf(code, versionId);
  }
}
