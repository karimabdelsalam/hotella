import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  ChannelAdminService,
  createChannelSchema,
  updateChannelSchema,
} from '../application/channel.service';

class CreateChannelDto extends createZodDto(createChannelSchema) {}
class UpdateChannelDto extends createZodDto(updateChannelSchema) {}

function propertyScope(ctx: RequestContext, actors: ActorStore, propertyId: string): PropertyScope {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.property.not_found');
  return { tenantId, propertyId };
}

/** A property's channels and the provider adapters they are bound to (ADR-0015). */
@Controller('properties/:propertyId/channels')
@PropertyScoped({ from: 'param' })
export class ChannelsController {
  constructor(
    private readonly channels: ChannelAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('channel.manage')
  list(@Param('propertyId') propertyId: string) {
    return this.channels.list(propertyScope(this.ctx, this.actors, propertyId));
  }

  @Get(':channelId')
  @RequirePermission('channel.manage')
  get(@Param('propertyId') propertyId: string, @Param('channelId') channelId: string) {
    return this.channels.get(propertyScope(this.ctx, this.actors, propertyId), channelId);
  }

  @Post()
  @RequirePermission('channel.manage')
  create(@Param('propertyId') propertyId: string, @Body() body: CreateChannelDto) {
    return this.channels.create(propertyScope(this.ctx, this.actors, propertyId), body);
  }

  @Patch(':channelId')
  @RequirePermission('channel.manage')
  update(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Body() body: UpdateChannelDto,
  ) {
    return this.channels.update(propertyScope(this.ctx, this.actors, propertyId), channelId, body);
  }
}
