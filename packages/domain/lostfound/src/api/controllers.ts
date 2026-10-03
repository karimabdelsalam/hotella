import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  decideMatchSchema,
  disposeSchema,
  ItemService,
  listItemsSchema,
  PHOTO_MAX_BYTES,
  registerItemSchema,
  releaseSchema,
  storageSchema,
} from '../application/item.service';

class RegisterItemDto extends createZodDto(registerItemSchema) {}
class ListItemsDto extends createZodDto(listItemsSchema) {}
class StorageDto extends createZodDto(storageSchema) {}
class DecideMatchDto extends createZodDto(decideMatchSchema) {}
class ReleaseDto extends createZodDto(releaseSchema) {}
class DisposeDto extends createZodDto(disposeSchema) {}

/** Reads a raw request body (a photo) and stops as soon as it is larger than allowed. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new AppError('lostfound.photo.too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Lost & Found of a property: items, photos, matches, release and disposal. */
@Controller('properties/:propertyId/lostfound')
@PropertyScoped({ from: 'param' })
export class LostFoundController {
  constructor(
    private readonly items: ItemService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.tenant.not_found');
    return { tenantId, propertyId };
  }

  @Get('items')
  @RequirePermission('lostfound.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string, @Query() query: ListItemsDto) {
    return this.items.list(this.scope(propertyId), query);
  }

  /** FOUND needs `lostfound.register`, LOST needs `lostfound.manage` (checked by the service). */
  @Post('items')
  @RequirePermission('lostfound.register', { checkedBy: 'gate' })
  register(@Param('propertyId') propertyId: string, @Body() body: RegisterItemDto) {
    return this.items.register(this.scope(propertyId), body);
  }

  @Get('items/:itemId')
  @RequirePermission('lostfound.read', { checkedBy: 'gate' })
  get(@Param('propertyId') propertyId: string, @Param('itemId') id: string) {
    return this.items.get(this.scope(propertyId), id);
  }

  @Post('items/:itemId/storage')
  @HttpCode(200)
  @RequirePermission('lostfound.manage', { checkedBy: 'gate' })
  storage(
    @Param('propertyId') propertyId: string,
    @Param('itemId') id: string,
    @Body() body: StorageDto,
  ) {
    return this.items.moveStorage(this.scope(propertyId), id, body);
  }

  /** The photo is the raw request body (`image/png`, `image/jpeg` or `image/webp`). */
  @Post('items/:itemId/photos')
  @RequirePermission('lostfound.register', { checkedBy: 'gate' })
  async addPhoto(
    @Param('propertyId') propertyId: string,
    @Param('itemId') id: string,
    @Req() req: IncomingMessage,
  ) {
    return this.items.addPhoto(this.scope(propertyId), id, await readBody(req, PHOTO_MAX_BYTES));
  }

  @Get('items/:itemId/photos/:name')
  @RequirePermission('lostfound.read', { checkedBy: 'gate' })
  @Header('cache-control', 'private, max-age=300')
  @Header('x-content-type-options', 'nosniff')
  async photo(
    @Param('propertyId') propertyId: string,
    @Param('itemId') id: string,
    @Param('name') name: string,
  ) {
    const { body, type } = await this.items.photo(this.scope(propertyId), id, name);
    return new StreamableFile(body, { type, length: body.length });
  }

  @Post('items/:itemId/release')
  @HttpCode(200)
  @RequirePermission('lostfound.release', { checkedBy: 'gate' })
  release(
    @Param('propertyId') propertyId: string,
    @Param('itemId') id: string,
    @Body() body: ReleaseDto,
  ) {
    return this.items.release(this.scope(propertyId), id, body);
  }

  @Post('items/:itemId/dispose')
  @HttpCode(200)
  @RequirePermission('lostfound.manage', { checkedBy: 'gate' })
  dispose(
    @Param('propertyId') propertyId: string,
    @Param('itemId') id: string,
    @Body() body: DisposeDto,
  ) {
    return this.items.dispose(this.scope(propertyId), id, body);
  }

  @Get('matches')
  @RequirePermission('lostfound.read', { checkedBy: 'gate' })
  matches(@Param('propertyId') propertyId: string) {
    return this.items.matches(this.scope(propertyId));
  }

  @Post('matches/:matchId/confirm')
  @HttpCode(200)
  @RequirePermission('lostfound.manage', { checkedBy: 'gate' })
  confirm(
    @Param('propertyId') propertyId: string,
    @Param('matchId') id: string,
    @Body() body: DecideMatchDto,
  ) {
    return this.items.confirmMatch(this.scope(propertyId), id, body);
  }

  @Post('matches/:matchId/reject')
  @HttpCode(200)
  @RequirePermission('lostfound.manage', { checkedBy: 'gate' })
  reject(
    @Param('propertyId') propertyId: string,
    @Param('matchId') id: string,
    @Body() body: DecideMatchDto,
  ) {
    return this.items.rejectMatch(this.scope(propertyId), id, body);
  }
}
