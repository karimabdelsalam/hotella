import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAPPING_TYPES } from '@hotella/contracts-connectors';
import {
  ActorStore,
  PropertyScoped,
  Public,
  RequirePermission,
  TenantScoped,
} from '@hotella/platform-auth';
import { RateLimit } from '@hotella/platform-http';
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
import {
  CapabilityAdminService,
  capabilityCodeSchema,
  commissionSchema,
  resetProfileSchema,
  routingOverrideSchema,
  unverifyCapabilitySchema,
  verifyCapabilitySchema,
} from '../application/capability-admin.service';
import {
  CommissioningService,
  commissioningRunSchema,
  sheetEntrySchema,
} from '../application/commissioning.service';
import { InboundEndpointService, rotateInboundSchema } from '../application/inbound.service';
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
class VerifyCapabilityDto extends createZodDto(verifyCapabilitySchema) {}
class UnverifyCapabilityDto extends createZodDto(unverifyCapabilitySchema) {}
class RoutingOverrideDto extends createZodDto(routingOverrideSchema) {}
class CommissionInstanceDto extends createZodDto(commissionSchema) {}
class ResetProfileDto extends createZodDto(resetProfileSchema) {}
class CommissioningSheetEntryDto extends createZodDto(sheetEntrySchema) {}
class CommissioningRunDto extends createZodDto(commissioningRunSchema) {}
class CreateWebhookDto extends createZodDto(createWebhookSchema) {}
class UpdateWebhookDto extends createZodDto(updateWebhookSchema) {}
class WebhookDeliveriesQueryDto extends createZodDto(webhookDeliveriesQuerySchema) {}
class InboundVersionDto extends createZodDto(rotateInboundSchema) {}
class InboundRevokeQueryDto extends createZodDto(
  z.object({ version: z.coerce.number().int().min(1) }),
) {}
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

function capabilityCode(raw: string) {
  const parsed = capabilityCodeSchema.safeParse(raw);
  if (!parsed.success)
    throw AppError.notFound('integration.capability.unknown', { capability: raw });
  return parsed.data;
}

/**
 * The per-property capability registry and routing (ADR-0019; guide §5, §16.5): installer and control-plane work —
 * what the property's PMS integration may do, through which connector, proven by whom.
 */
@Controller('properties/:propertyId/integration')
@PropertyScoped({ from: 'param' })
export class PropertyCapabilitiesController {
  constructor(
    private readonly admin: CapabilityAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get('capabilities')
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  view(@Param('propertyId') propertyId: string) {
    return this.admin.view(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Get('capabilities/history')
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  history(@Param('propertyId') propertyId: string) {
    return this.admin.history(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Post('capabilities/:capability/verify')
  @HttpCode(200)
  @RequirePermission('integration.capability.verify', { checkedBy: 'gate' })
  verify(
    @Param('propertyId') propertyId: string,
    @Param('capability') capability: string,
    @Body() body: VerifyCapabilityDto,
  ) {
    return this.admin.verify(
      propertyScope(this.ctx, this.actors, propertyId),
      capabilityCode(capability),
      body,
    );
  }

  @Post('capabilities/:capability/unverify')
  @HttpCode(200)
  @RequirePermission('integration.capability.verify', { checkedBy: 'gate' })
  unverify(
    @Param('propertyId') propertyId: string,
    @Param('capability') capability: string,
    @Body() body: UnverifyCapabilityDto,
  ) {
    return this.admin.unverify(
      propertyScope(this.ctx, this.actors, propertyId),
      capabilityCode(capability),
      body,
    );
  }

  @Post('instances/:instanceId/commission')
  @HttpCode(200)
  @RequirePermission('integration.capability.verify', { checkedBy: 'gate' })
  commission(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: CommissionInstanceDto,
  ) {
    return this.admin.commission(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      body,
    );
  }

  /** Interface profile coverage of an instance (guide §7.3, §16.2): what the hotel's PMS delivers, and the gaps. */
  @Get('instances/:instanceId/profile')
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  profile(@Param('propertyId') propertyId: string, @Param('instanceId') instanceId: string) {
    return this.admin.profile(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Post('instances/:instanceId/profile/reset')
  @HttpCode(200)
  @RequirePermission('integration.capability.verify', { checkedBy: 'gate' })
  resetProfile(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: ResetProfileDto,
  ) {
    return this.admin.resetProfile(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      body,
    );
  }

  /** The read log of the property's agents (never the answers), for installers and support. */
  @Get('queries')
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  queries(@Param('propertyId') propertyId: string) {
    return this.admin.queries(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Put('routing/:operation')
  @RequirePermission('integration.capability.manage', { checkedBy: 'gate' })
  routing(
    @Param('propertyId') propertyId: string,
    @Param('operation') operation: string,
    @Body() body: RoutingOverrideDto,
  ) {
    return this.admin.setRouting(propertyScope(this.ctx, this.actors, propertyId), operation, body);
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

/**
 * Commissioning of a property's PMS integration (guide §16, §20; BUILD_PLAN 10.9): the Interface Sheet compared with
 * the standard, verification runs, and the readiness checklist. Installer and control-plane work.
 */
@Controller('properties/:propertyId/integration/commissioning')
@PropertyScoped({ from: 'param' })
export class CommissioningController {
  constructor(
    private readonly commissioning: CommissioningService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  view(@Param('propertyId') propertyId: string) {
    return this.commissioning.view(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Get('sheet/history')
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  sheetHistory(@Param('propertyId') propertyId: string) {
    return this.commissioning.sheetHistory(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Put('sheet/:requirement')
  @RequirePermission('integration.capability.verify', { checkedBy: 'gate' })
  recordSheet(
    @Param('propertyId') propertyId: string,
    @Param('requirement') requirement: string,
    @Body() body: CommissioningSheetEntryDto,
  ) {
    return this.commissioning.recordSheet(
      propertyScope(this.ctx, this.actors, propertyId),
      requirement,
      body,
    );
  }

  @Get('runs')
  @RequirePermission('integration.read', { checkedBy: 'gate' })
  runs(@Param('propertyId') propertyId: string) {
    return this.commissioning.runs(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Post('runs')
  @HttpCode(200)
  @RequirePermission('integration.capability.verify', { checkedBy: 'gate' })
  run(@Param('propertyId') propertyId: string, @Body() body: CommissioningRunDto) {
    return this.commissioning.run(propertyScope(this.ctx, this.actors, propertyId), body);
  }
}

/** Signed inbound endpoints of an integration instance (ADR-0024): the secret is shown at creation and rotation only. */
@Controller('properties/:propertyId/integrations/:instanceId/inbound-endpoints')
@PropertyScoped({ from: 'param' })
export class InboundEndpointsController {
  constructor(
    private readonly inbound: InboundEndpointService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('integration.read')
  list(@Param('propertyId') propertyId: string, @Param('instanceId') instanceId: string) {
    return this.inbound.list(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Post()
  @RequirePermission('integration.configure')
  create(@Param('propertyId') propertyId: string, @Param('instanceId') instanceId: string) {
    return this.inbound.create(propertyScope(this.ctx, this.actors, propertyId), instanceId);
  }

  @Post(':endpointId/rotate')
  @HttpCode(200)
  @RequirePermission('integration.configure')
  rotate(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Param('endpointId') endpointId: string,
    @Body() body: InboundVersionDto,
  ) {
    return this.inbound.rotate(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      endpointId,
      body.version,
    );
  }

  @Delete(':endpointId')
  @RequirePermission('integration.configure')
  revoke(
    @Param('propertyId') propertyId: string,
    @Param('instanceId') instanceId: string,
    @Param('endpointId') endpointId: string,
    @Query() query: InboundRevokeQueryDto,
  ) {
    return this.inbound.revoke(
      propertyScope(this.ctx, this.actors, propertyId),
      instanceId,
      endpointId,
      query.version,
    );
  }
}

/** Where cloud-hosted vendor systems post signed batches of raw messages (public; the signature authenticates). */
@Controller('integrations/inbound')
@Public()
export class InboundIngressController {
  constructor(private readonly inbound: InboundEndpointService) {}

  @Post(':endpointId')
  @HttpCode(200)
  @RateLimit({ name: 'integration-inbound', limit: 3000, windowSeconds: 60, keyBy: 'ip' })
  receive(
    @Param('endpointId') endpointId: string,
    @Headers('x-hotella-signature') signature: string | undefined,
    @Req() req: Request,
  ) {
    return this.inbound.receive(
      endpointId,
      (req as Request & { rawBody?: Buffer }).rawBody,
      signature,
    );
  }
}
