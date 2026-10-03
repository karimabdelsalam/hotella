import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
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
