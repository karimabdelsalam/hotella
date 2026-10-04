import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAPPING_TYPES } from '@hotella/contracts-connectors';
import {
  ActorStore,
  PropertyScoped,
  RequirePermission,
  TenantScoped,
} from '@hotella/platform-auth';
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
import { ReconciliationService } from '../application/reconciliation.service';
import { ReplayService } from '../application/replay.service';
import {
  createWebhookSchema,
  updateWebhookSchema,
  webhookDeliveriesQuerySchema,
  WebhookService,
} from '../application/webhook.service';
import { EnrollmentService } from '../link/enrollment.service';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '../public';

class CreateInstanceDto extends createZodDto(createInstanceSchema) {}
class UpdateInstanceDto extends createZodDto(updateInstanceSchema) {}
class ConfirmMappingDto extends createZodDto(confirmMappingSchema) {}
class ListMessagesQueryDto extends createZodDto(listMessagesQuerySchema) {}
class ListExceptionsQueryDto extends createZodDto(listExceptionsQuerySchema) {}
class CloseExceptionDto extends createZodDto(closeExceptionSchema) {}
class MappingQueryDto extends createZodDto(z.object({ type: z.enum(MAPPING_TYPES).optional() })) {}
class RevokeAgentDto extends createZodDto(
  z.object({ reason: z.string().trim().min(3).max(500) }),
) {}
class CreateWebhookDto extends createZodDto(createWebhookSchema) {}
class UpdateWebhookDto extends createZodDto(updateWebhookSchema) {}
class WebhookDeliveriesQueryDto extends createZodDto(webhookDeliveriesQuerySchema) {}
class ExternalReferenceQueryDto extends createZodDto(
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
    private readonly replays: ReplayService,
    private readonly enrollment: EnrollmentService,
    private readonly reconciliation: ReconciliationService,
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

  /** ADR-0017 §2: a single-use, time-limited token the installer pastes into the hotel agent. Shown once. */
  @Post(':instanceId/enrollment-tokens')
  @RequirePermission('integration.configure')
  enrollmentToken(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.enrollment.createToken(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
    );
  }

  @Get(':instanceId/agent')
  @RequirePermission('integration.read')
  agent(@Param('propertyId') propertyId: string, @Param('instanceId') instanceId: string) {
    return this.enrollment.status(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Post(':instanceId/agent/revoke')
  @HttpCode(200)
  @RequirePermission('integration.configure')
  revokeAgent(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: RevokeAgentDto,
  ) {
    return this.enrollment.revoke(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      body.reason,
    );
  }

  /** Spec §52: ask the PMS for its in-house list and compare it with the platform's stays. */
  @Post(':instanceId/reconciliations')
  @RequirePermission('integration.reconcile')
  startReconciliation(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.reconciliation.start(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Get(':instanceId/reconciliations')
  @RequirePermission('integration.read')
  reconciliations(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.reconciliation.list(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Get(':instanceId/reconciliations/:runId')
  @RequirePermission('integration.read')
  reconciliationRun(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Param('runId') runId: string,
  ) {
    return this.reconciliation.get(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      runId,
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
    return this.replays.replayPending(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Post(':instanceId/messages/:messageId/replay')
  @HttpCode(200)
  @RequirePermission('integration.replay')
  replay(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.replays.replay(
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
  references(@Param('propertyId') propertyId: string, @Query() query: ExternalReferenceQueryDto) {
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

/** Outbound webhooks of a tenant (Spec §75 developer platform, BUILD_PLAN 11.5). */
@Controller('tenants/:tenantId/webhooks')
@TenantScoped({ from: 'param' })
export class WebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  @Get()
  @RequirePermission('integration.webhook.manage', { checkedBy: 'gate' })
  list(@Param('tenantId') tenantId: string) {
    return this.webhooks.list({ tenantId });
  }

  @Post()
  @RequirePermission('integration.webhook.manage', { checkedBy: 'gate' })
  create(@Param('tenantId') tenantId: string, @Body() body: CreateWebhookDto) {
    return this.webhooks.create({ tenantId }, body);
  }

  @Patch(':webhookId')
  @RequirePermission('integration.webhook.manage', { checkedBy: 'gate' })
  update(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
    @Body() body: UpdateWebhookDto,
  ) {
    return this.webhooks.update({ tenantId }, webhookId, body);
  }

  @Post(':webhookId/rotate-secret')
  @HttpCode(200)
  @RequirePermission('integration.webhook.manage', { checkedBy: 'gate' })
  rotate(@Param('tenantId') tenantId: string, @Param('webhookId') webhookId: string) {
    return this.webhooks.rotateSecret({ tenantId }, webhookId);
  }

  @Get(':webhookId/deliveries')
  @RequirePermission('integration.webhook.manage', { checkedBy: 'gate' })
  deliveries(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
    @Query() query: WebhookDeliveriesQueryDto,
  ) {
    return this.webhooks.deliveries({ tenantId }, webhookId, query);
  }

  @Post(':webhookId/deliveries/:deliveryId/replay')
  @HttpCode(200)
  @RequirePermission('integration.webhook.manage', { checkedBy: 'gate' })
  replay(
    @Param('tenantId') tenantId: string,
    @Param('webhookId') webhookId: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.webhooks.replay({ tenantId }, webhookId, deliveryId);
  }
}
