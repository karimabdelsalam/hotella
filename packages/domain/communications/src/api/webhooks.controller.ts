import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@hotella/platform-auth';
import { RateLimit } from '@hotella/platform-http';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import { ChannelRuntime } from '../application/channel.service';
import { ConversationService } from '../application/conversation.service';
import { CommsRepositories } from '../infrastructure/repositories';
import type { ChannelRow } from '../infrastructure/schema';

/**
 * Provider webhooks (ADR-0015): `POST /webhooks/whatsapp/:channelId` and `/webhooks/sms/:channelId`. The channel id in
 * the URL selects the adapter; the adapter's signature check over the raw body decides whether anything is stored.
 * Unknown or disabled channels and bad signatures get a bare 404/401 (nothing is stored, nothing is explained).
 */
@Controller('webhooks')
@Public()
export class WebhooksController {
  constructor(
    private readonly comms: CommsRepositories,
    private readonly runtime: ChannelRuntime,
    private readonly engine: ConversationService,
    private readonly ctx: RequestContext,
  ) {}

  /** Meta's subscription handshake: echo `hub.challenge` when `hub.verify_token` matches the channel's. */
  @Get('whatsapp/:channelId')
  @RateLimit({ name: 'webhook-verify', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  async subscribe(
    @Param('channelId') channelId: string,
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const channel = await this.channel(channelId, 'WHATSAPP');
    const adapter = this.runtime.adapterFor(channel);
    const ok =
      mode === 'subscribe' &&
      typeof challenge === 'string' &&
      adapter.verifySubscription !== undefined &&
      (await adapter.verifySubscription(this.runtime.context(channel), token));
    if (!ok) throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);
    res.status(200).type('text/plain').send(challenge);
  }

  @Post('whatsapp/:channelId')
  @HttpCode(200)
  @RateLimit({ name: 'webhook-whatsapp', limit: 3000, windowSeconds: 60, keyBy: 'ip' })
  whatsapp(@Param('channelId') channelId: string, @Req() req: Request) {
    return this.receive(channelId, 'WHATSAPP', req);
  }

  @Post('sms/:channelId')
  @HttpCode(200)
  @RateLimit({ name: 'webhook-sms', limit: 3000, windowSeconds: 60, keyBy: 'ip' })
  sms(@Param('channelId') channelId: string, @Req() req: Request) {
    return this.receive(channelId, 'SMS', req);
  }

  private async receive(channelId: string, type: ChannelRow['type'], req: Request) {
    const channel = await this.channel(channelId, type);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!raw)
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
    const adapter = this.runtime.adapterFor(channel);
    const ctx = this.runtime.context(channel);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers))
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    if (!(await adapter.verifyWebhook(ctx, { rawBody: raw, headers })))
      throw new AppError('platform.unauthorized', HttpStatus.UNAUTHORIZED);
    this.ctx.setScope({
      tenantId: channel.tenantId,
      propertyId: channel.propertyId,
      actor: { type: 'INTEGRATION', id: channel.id },
    });
    const items = adapter.parseWebhook(ctx, req.body as unknown);
    const { stored } = await this.engine.ingest(channel, items);
    return { received: items.length, stored };
  }

  private async channel(channelId: string, type: ChannelRow['type']): Promise<ChannelRow> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(channelId);
    const channel = uuid ? await this.comms.channelById(channelId) : undefined;
    if (!channel || channel.type !== type || channel.status !== 'ACTIVE') throw AppError.notFound();
    return channel;
  }
}
