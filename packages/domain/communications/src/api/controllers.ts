import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  ActivationAdminService,
  assistSchema,
  issueTokenSchema,
  qrSheetSchema,
  referenceQuerySchema,
  RoomQrAdminService,
} from '../application/activation-admin.service';
import {
  aiModeSchema,
  assignConversationSchema,
  InboxService,
  inboxQuerySchema,
  replySchema,
  takeoverSchema,
} from '../application/inbox.service';
import { callsQuerySchema, VoiceService } from '../application/voice.service';
import {
  roomsByNumberSchema,
  VoiceDirectoryService,
  voiceDirectorySchema,
} from '../application/voice-directory.service';
import {
  ChannelAdminService,
  createChannelSchema,
  updateChannelSchema,
} from '../application/channel.service';

class CreateChannelDto extends createZodDto(createChannelSchema) {}
class UpdateChannelDto extends createZodDto(updateChannelSchema) {}
class IssueTokenDto extends createZodDto(issueTokenSchema) {}
class AssistDto extends createZodDto(assistSchema) {}
class QrSheetDto extends createZodDto(qrSheetSchema) {}
class ReferenceQueryDto extends createZodDto(referenceQuerySchema) {}
class InboxQueryDto extends createZodDto(inboxQuerySchema) {}
class ReplyDto extends createZodDto(replySchema) {}
class AssignConversationDto extends createZodDto(assignConversationSchema) {}
class TakeoverDto extends createZodDto(takeoverSchema) {}
class AiModeDto extends createZodDto(aiModeSchema) {}
class CallsQueryDto extends createZodDto(callsQuerySchema) {}
class VoiceDirectoryDto extends createZodDto(voiceDirectorySchema) {}
class RoomsByNumberDto extends createZodDto(roomsByNumberSchema) {}

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

/** Front desk: activation links and staff-assisted verification (Spec §19, ADR-0015). */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class ActivationController {
  constructor(
    private readonly activation: ActivationAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private actor() {
    const a = this.actors.require();
    return { type: a.type, id: a.id };
  }

  @Post('stays/:stayId/activation-tokens')
  @RequirePermission('guest.activation.issue')
  issue(
    @Param('propertyId') propertyId: string,
    @Param('stayId') stayId: string,
    @Body() body: IssueTokenDto,
  ) {
    return this.activation.issue(
      propertyScope(this.ctx, this.actors, propertyId),
      stayId,
      body,
      this.actor(),
    );
  }

  @Get('stays/:stayId/activation-tokens')
  @RequirePermission('guest.activation.issue')
  list(@Param('propertyId') propertyId: string, @Param('stayId') stayId: string) {
    return this.activation.list(propertyScope(this.ctx, this.actors, propertyId), stayId);
  }

  @Post('activation-tokens/:tokenId/revoke')
  @HttpCode(200)
  @RequirePermission('guest.activation.issue')
  revoke(@Param('propertyId') propertyId: string, @Param('tokenId') tokenId: string) {
    return this.activation.revoke(propertyScope(this.ctx, this.actors, propertyId), tokenId);
  }

  @Get('verification-sessions')
  @RequirePermission('guest.activation.assist')
  find(@Param('propertyId') propertyId: string, @Query() query: ReferenceQueryDto) {
    return this.activation.findForAssist(
      propertyScope(this.ctx, this.actors, propertyId),
      query.reference,
    );
  }

  @Post('verification-sessions/:sessionId/assist')
  @HttpCode(200)
  @RequirePermission('guest.activation.assist')
  assist(
    @Param('propertyId') propertyId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: AssistDto,
  ) {
    return this.activation.assist(
      propertyScope(this.ctx, this.actors, propertyId),
      sessionId,
      body.reason,
      this.actor(),
    );
  }
}

/** Room QR codes: generate/rotate (token shown once), revoke, list (Spec §20). */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class RoomQrController {
  constructor(
    private readonly qr: RoomQrAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  @Get('room-qr-codes')
  @RequirePermission('qr.manage')
  list(@Param('propertyId') propertyId: string) {
    return this.qr.list(propertyScope(this.ctx, this.actors, propertyId));
  }

  /** Printable sheet (HTML; print to paper or PDF). Rotates the printed rooms' codes: earlier prints stop working. */
  @Post('room-qr-codes/sheet')
  @HttpCode(200)
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  @RequirePermission('qr.manage')
  sheet(@Param('propertyId') propertyId: string, @Body() body: QrSheetDto) {
    return this.qr.sheet(
      propertyScope(this.ctx, this.actors, propertyId),
      body.roomIds,
      this.locale.get(),
    );
  }

  @Post('rooms/:roomId/qr-code')
  @RequirePermission('qr.manage')
  generate(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string) {
    return this.qr.generate(propertyScope(this.ctx, this.actors, propertyId), roomId);
  }

  @Post('rooms/:roomId/qr-code/revoke')
  @HttpCode(200)
  @RequirePermission('qr.manage')
  revoke(@Param('propertyId') propertyId: string, @Param('roomId') roomId: string) {
    return this.qr.revoke(propertyScope(this.ctx, this.actors, propertyId), roomId);
  }
}

/** The staff inbox (Spec §18): conversations with guest, stay, room and open work; reply, assign, take over, close. */
@Controller('properties/:propertyId/conversations')
@PropertyScoped({ from: 'param' })
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    return propertyScope(this.ctx, this.actors, propertyId);
  }
  private actor() {
    const a = this.actors.require();
    return { type: a.type, id: a.id };
  }

  @Get()
  @RequirePermission('inbox.read')
  list(@Param('propertyId') propertyId: string, @Query() query: InboxQueryDto) {
    return this.inbox.list(this.scope(propertyId), query, this.actor());
  }

  @Get(':conversationId')
  @RequirePermission('inbox.read')
  detail(@Param('propertyId') propertyId: string, @Param('conversationId') id: string) {
    return this.inbox.detail(this.scope(propertyId), id);
  }

  @Post(':conversationId/messages')
  @RequirePermission('inbox.reply')
  reply(
    @Param('propertyId') propertyId: string,
    @Param('conversationId') id: string,
    @Body() body: ReplyDto,
  ) {
    return this.inbox.reply(this.scope(propertyId), id, body, this.actor());
  }

  @Post(':conversationId/assign')
  @HttpCode(200)
  @RequirePermission('inbox.assign')
  assign(
    @Param('propertyId') propertyId: string,
    @Param('conversationId') id: string,
    @Body() body: AssignConversationDto,
  ) {
    return this.inbox.assign(this.scope(propertyId), id, body);
  }

  @Post(':conversationId/takeover')
  @HttpCode(200)
  @RequirePermission('inbox.takeover')
  takeover(
    @Param('propertyId') propertyId: string,
    @Param('conversationId') id: string,
    @Body() body: TakeoverDto,
  ) {
    return this.inbox.takeover(this.scope(propertyId), id, body.reason, this.actor());
  }

  @Post(':conversationId/ai-mode')
  @HttpCode(200)
  @RequirePermission('inbox.takeover')
  aiMode(
    @Param('propertyId') propertyId: string,
    @Param('conversationId') id: string,
    @Body() body: AiModeDto,
  ) {
    return this.inbox.setAiMode(this.scope(propertyId), id, body.mode, this.actor());
  }

  @Post(':conversationId/close')
  @HttpCode(200)
  @RequirePermission('inbox.reply')
  close(@Param('propertyId') propertyId: string, @Param('conversationId') id: string) {
    return this.inbox.close(this.scope(propertyId), id);
  }
}

/** Voice calls of a property (BUILD_PLAN 13.4): who was answered, who was transferred and why. No caller numbers. */
@Controller('properties/:propertyId/calls')
@PropertyScoped({ from: 'param' })
export class CallsController {
  constructor(
    private readonly voice: VoiceService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('inbox.read')
  list(@Param('propertyId') propertyId: string, @Query() query: CallsQueryDto) {
    return this.voice.list(propertyScope(this.ctx, this.actors, propertyId), query);
  }
}

/** The extension directory of a voice channel (ADR-0025, Q27): which extensions are guest rooms. */
@Controller('properties/:propertyId/channels/:channelId/extensions')
@PropertyScoped({ from: 'param' })
export class VoiceDirectoryController {
  constructor(
    private readonly directory: VoiceDirectoryService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  @Get()
  @RequirePermission('channel.manage')
  list(@Param('propertyId') propertyId: string, @Param('channelId') channelId: string) {
    return this.directory.list(propertyScope(this.ctx, this.actors, propertyId), channelId);
  }

  @Put()
  @RequirePermission('channel.manage')
  replace(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Body() body: VoiceDirectoryDto,
  ) {
    return this.directory.replace(
      propertyScope(this.ctx, this.actors, propertyId),
      channelId,
      body,
    );
  }

  @Post('rooms-by-number')
  @HttpCode(200)
  @RequirePermission('channel.manage')
  roomsByNumber(
    @Param('propertyId') propertyId: string,
    @Param('channelId') channelId: string,
    @Body() body: RoomsByNumberDto,
  ) {
    return this.directory.roomsByNumber(
      propertyScope(this.ctx, this.actors, propertyId),
      channelId,
      body,
    );
  }
}
