import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  AlertAdminService,
  listAlertsQuerySchema,
  resolveAlertSchema,
} from '../application/alert.service';
import {
  createBusinessHoursSchema,
  createSlaPolicySchema,
  SlaAdminService,
  updateBusinessHoursSchema,
  updateSlaPolicySchema,
} from '../application/sla-admin.service';
import {
  listTasksQuerySchema,
  listWorkItemsQuerySchema,
  OperationsQueryService,
} from '../application/queries';
import {
  assignTaskSchema,
  reasonRequiredSchema,
  taskActionSchema,
  TaskService,
} from '../application/task.service';

class ListTasksQueryDto extends createZodDto(listTasksQuerySchema) {}
class ListWorkItemsQueryDto extends createZodDto(listWorkItemsQuerySchema) {}
class AssignTaskDto extends createZodDto(assignTaskSchema) {}
class TaskActionDto extends createZodDto(taskActionSchema) {}
class ReasonRequiredDto extends createZodDto(reasonRequiredSchema) {}

function propertyScope(ctx: RequestContext, actors: ActorStore, propertyId: string): PropertyScope {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.property.not_found');
  return { tenantId, propertyId };
}

/**
 * Staff side of the operations engine. Work items are created by modules (OPERATIONS_API), so there is no generic
 * "create work item" route; staff see, take and finish the work.
 */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class OperationsController {
  constructor(
    private readonly queries: OperationsQueryService,
    private readonly tasks: TaskService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    return propertyScope(this.ctx, this.actors, propertyId);
  }

  @Get('work-items')
  @RequirePermission('task.read')
  listWorkItems(@Param('propertyId') propertyId: string, @Query() query: ListWorkItemsQueryDto) {
    return this.queries.listWorkItems(this.scope(propertyId), query);
  }

  @Get('work-items/:workItemId')
  @RequirePermission('task.read')
  workItem(@Param('propertyId') propertyId: string, @Param('workItemId') workItemId: string) {
    return this.queries.getWorkItem(this.scope(propertyId), workItemId);
  }

  @Get('tasks')
  @RequirePermission('task.read')
  listTasks(@Param('propertyId') propertyId: string, @Query() query: ListTasksQueryDto) {
    return this.queries.listTasks(this.scope(propertyId), query);
  }

  @Get('tasks/:taskId')
  @RequirePermission('task.read')
  task(@Param('propertyId') propertyId: string, @Param('taskId') taskId: string) {
    return this.queries.getTask(this.scope(propertyId), taskId);
  }

  @Post('tasks/:taskId/assign')
  @HttpCode(200)
  @RequirePermission('task.assign')
  assign(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: AssignTaskDto,
  ) {
    return this.tasks.assign(this.scope(propertyId), taskId, body);
  }

  @Post('tasks/:taskId/unassign')
  @HttpCode(200)
  @RequirePermission('task.assign')
  unassign(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: TaskActionDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'UNASSIGN', body);
  }

  @Post('tasks/:taskId/accept')
  @HttpCode(200)
  @RequirePermission('task.accept')
  accept(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: TaskActionDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'ACCEPT', body);
  }

  @Post('tasks/:taskId/reject')
  @HttpCode(200)
  @RequirePermission('task.accept')
  reject(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: ReasonRequiredDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'REJECT', body);
  }

  @Post('tasks/:taskId/start')
  @HttpCode(200)
  @RequirePermission('task.accept')
  start(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: TaskActionDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'START', body);
  }

  @Post('tasks/:taskId/pause')
  @HttpCode(200)
  @RequirePermission('task.accept')
  pause(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: ReasonRequiredDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'PAUSE', body);
  }

  @Post('tasks/:taskId/resume')
  @HttpCode(200)
  @RequirePermission('task.accept')
  resume(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: TaskActionDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'RESUME', body);
  }

  @Post('tasks/:taskId/complete')
  @HttpCode(200)
  @RequirePermission('task.complete')
  complete(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: TaskActionDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'COMPLETE', body);
  }

  @Post('tasks/:taskId/cancel')
  @HttpCode(200)
  @RequirePermission('task.cancel')
  cancel(
    @Param('propertyId') propertyId: string,
    @Param('taskId') taskId: string,
    @Body() body: ReasonRequiredDto,
  ) {
    return this.tasks.act(this.scope(propertyId), taskId, 'CANCEL', body);
  }
}

class CreateBusinessHoursDto extends createZodDto(createBusinessHoursSchema) {}
class UpdateBusinessHoursDto extends createZodDto(updateBusinessHoursSchema) {}
class CreateSlaPolicyDto extends createZodDto(createSlaPolicySchema) {}
class UpdateSlaPolicyDto extends createZodDto(updateSlaPolicySchema) {}
class ListAlertsQueryDto extends createZodDto(listAlertsQuerySchema) {}
class ResolveAlertDto extends createZodDto(resolveAlertSchema) {}

/** Business hours and SLA policies of a property (Spec §8.3). */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class SlaAdminController {
  constructor(
    private readonly admin: SlaAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    return propertyScope(this.ctx, this.actors, propertyId);
  }

  @Get('business-hours')
  @RequirePermission('sla.manage')
  listBusinessHours(@Param('propertyId') propertyId: string) {
    return this.admin.listBusinessHours(this.scope(propertyId));
  }

  @Post('business-hours')
  @RequirePermission('sla.manage')
  createBusinessHours(
    @Param('propertyId') propertyId: string,
    @Body() body: CreateBusinessHoursDto,
  ) {
    return this.admin.createBusinessHours(this.scope(propertyId), body);
  }

  @Patch('business-hours/:id')
  @RequirePermission('sla.manage')
  updateBusinessHours(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Body() body: UpdateBusinessHoursDto,
  ) {
    return this.admin.updateBusinessHours(this.scope(propertyId), id, body);
  }

  @Get('sla-policies')
  @RequirePermission('sla.manage')
  listPolicies(@Param('propertyId') propertyId: string) {
    return this.admin.listPolicies(this.scope(propertyId));
  }

  @Post('sla-policies')
  @RequirePermission('sla.manage')
  createPolicy(@Param('propertyId') propertyId: string, @Body() body: CreateSlaPolicyDto) {
    return this.admin.createPolicy(this.scope(propertyId), body);
  }

  @Patch('sla-policies/:id')
  @RequirePermission('sla.manage')
  updatePolicy(
    @Param('propertyId') propertyId: string,
    @Param('id') id: string,
    @Body() body: UpdateSlaPolicyDto,
  ) {
    return this.admin.updatePolicy(this.scope(propertyId), id, body);
  }
}

/** The alert board (Spec §15): conditions needing attention, acknowledged and resolved by staff. */
@Controller('properties/:propertyId/alerts')
@PropertyScoped({ from: 'param' })
export class AlertsController {
  constructor(
    private readonly alerts: AlertAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('alert.read')
  list(@Param('propertyId') propertyId: string, @Query() query: ListAlertsQueryDto) {
    return this.alerts.list(propertyScope(this.ctx, this.actors, propertyId), query);
  }

  @Post(':alertId/acknowledge')
  @HttpCode(200)
  @RequirePermission('alert.ack')
  acknowledge(@Param('propertyId') propertyId: string, @Param('alertId') alertId: string) {
    return this.alerts.acknowledge(propertyScope(this.ctx, this.actors, propertyId), alertId);
  }

  @Post(':alertId/resolve')
  @HttpCode(200)
  @RequirePermission('alert.ack')
  resolve(
    @Param('propertyId') propertyId: string,
    @Param('alertId') alertId: string,
    @Body() body: ResolveAlertDto,
  ) {
    return this.alerts.resolve(
      propertyScope(this.ctx, this.actors, propertyId),
      alertId,
      body.resolution,
    );
  }
}
