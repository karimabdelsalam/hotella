import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAPPING_TYPES } from '@hotella/contracts-connectors';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { ActionGate } from '@hotella/platform-auth';
import {
  closeExceptionSchema,
  confirmMappingSchema,
  createInstanceSchema,
  listExceptionsQuerySchema,
  listMessagesQuerySchema,
  updateInstanceSchema,
} from '../application/dto';
import {
  ConnectorCatalogService,
  ExceptionService,
  InstanceService,
  MappingService,
} from '../application/admin.services';
import { IngestService } from '../application/ingest.service';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '../public';

class CreateInstanceDto extends createZodDto(createInstanceSchema) {}
class UpdateInstanceDto extends createZodDto(updateInstanceSchema) {}
class ConfirmMappingDto extends createZodDto(confirmMappingSchema) {}
class ListMessagesQueryDto extends createZodDto(listMessagesQuerySchema) {}
class ListExceptionsQueryDto extends createZodDto(listExceptionsQuerySchema) {}
class CloseExceptionDto extends createZodDto(closeExceptionSchema) {}
class MappingQueryDto extends createZodDto(z.object({ type: z.enum(MAPPING_TYPES).optional() })) {}
class ReferenceQueryDto extends createZodDto(
  z.object({ entityType: z.string().regex(/^[a-z]+\.[a-z_]+$/), entityId: z.uuid() }),
) {}

/** Tenant of the request: the actor's own, or the one the guard derived from the property for platform staff. */
function propertyScope(ctx: RequestContext, actors: ActorStore, propertyId: string): PropertyScope {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.property.not_found');
  return { tenantId, propertyId };
}

@Controller('properties/:propertyId/integrations')
@PropertyScoped({ from: 'param' })
export class IntegrationInstancesController {
  constructor(
    private readonly catalog: ConnectorCatalogService,
    private readonly instances: InstanceService,
    private readonly mappings: MappingService,
    private readonly ingest: IngestService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get('connectors')
  @RequirePermission('integration.read')
  connectors() {
    return this.catalog.list();
  }

  @Get()
  @RequirePermission('integration.read')
  list(@Param('propertyId') propertyId: string) {
    return this.instances.list(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Post()
  @RequirePermission('integration.configure')
  create(@Param('propertyId') propertyId: string, @Body() body: CreateInstanceDto) {
    return this.instances.create(propertyScope(this.ctx, this.actors, propertyId), body);
  }

  @Get(':instanceId')
  @RequirePermission('integration.read')
  get(@Param('propertyId') propertyId: string, @Param('instanceId') instanceId: string) {
    return this.instances.get(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Patch(':instanceId')
  @RequirePermission('integration.configure')
  update(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: UpdateInstanceDto,
  ) {
    return this.instances.update(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      body,
    );
  }

  @Get(':instanceId/messages')
  @RequirePermission('integration.read')
  messages(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.instances.messages(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      query,
    );
  }

  @Post(':instanceId/messages/replay-pending')
  @HttpCode(200)
  @RequirePermission('integration.replay')
  replayPending(@Param('propertyId') propertyId: string, @Param('instanceId') instanceId: string) {
    return this.ingest.replayPending(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Post(':instanceId/messages/:messageId/replay')
  @HttpCode(200)
  @RequirePermission('integration.replay')
  replay(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.ingest.replay(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      messageId,
    );
  }

  @Get(':instanceId/mappings')
  @RequirePermission('integration.read')
  listMappings(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Query() query: MappingQueryDto,
  ) {
    return this.mappings.list(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      query.type,
    );
  }

  @Post(':instanceId/mappings')
  @HttpCode(200)
  @RequirePermission('integration.mapping.confirm')
  confirmMapping(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: ConfirmMappingDto,
  ) {
    return this.mappings.confirm(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      body,
    );
  }

  @Post(':instanceId/mappings/rooms-by-number')
  @HttpCode(200)
  @RequirePermission('integration.mapping.confirm')
  confirmRoomsByNumber(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.mappings.confirmRoomsByNumber(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
    );
  }
}

@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class IntegrationQueueController {
  constructor(
    private readonly exceptions: ExceptionService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
  ) {}

  @Get('integration-exceptions')
  @RequirePermission('integration.read')
  listExceptions(@Param('propertyId') propertyId: string, @Query() query: ListExceptionsQueryDto) {
    return this.exceptions.list(propertyScope(this.ctx, this.actors, propertyId), query);
  }

  @Post('integration-exceptions/:exceptionId/close')
  @HttpCode(200)
  @RequirePermission('integration.mapping.confirm')
  closeException(
    @Param('propertyId') propertyId: string,
    @Param('exceptionId') exceptionId: string,
    @Body() body: CloseExceptionDto,
  ) {
    return this.exceptions.close(
      propertyScope(this.ctx, this.actors, propertyId),
      exceptionId,
      body,
    );
  }

  /** Which external ids an internal entity carries (support and reconciliation; Spec §6 external references). */
  @Get('external-references')
  @RequirePermission('integration.read')
  references(@Param('propertyId') propertyId: string, @Query() query: ReferenceQueryDto) {
    const scope = propertyScope(this.ctx, this.actors, propertyId);
    return this.gate.execute(
      { action: 'integration.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(() =>
          this.integrations.referencesFor(scope.tenantId, query.entityType, query.entityId),
        ),
    );
  }
}
