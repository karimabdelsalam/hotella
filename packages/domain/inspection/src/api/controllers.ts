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
  Put,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  answerItemSchema,
  InspectionService,
  listInspectionsSchema,
  PHOTO_MAX_BYTES,
  startInspectionSchema,
} from '../application/inspection.service';
import {
  createTemplateSchema,
  TemplateService,
  versionContentSchema,
} from '../application/template.service';

class CreateTemplateDto extends createZodDto(createTemplateSchema) {}
class VersionContentDto extends createZodDto(versionContentSchema) {}
class TemplateQueryDto extends createZodDto(z.object({ versionId: z.uuid().optional() })) {}
class StartInspectionDto extends createZodDto(startInspectionSchema) {}
class AnswerItemDto extends createZodDto(answerItemSchema) {}
class ListInspectionsDto extends createZodDto(listInspectionsSchema) {}

/** Reads a raw request body (a photo) and stops as soon as it is larger than allowed. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new AppError('inspection.photo.too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tenantOf(ctx: RequestContext, actors: ActorStore): string {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.tenant.not_found');
  return tenantId;
}

/** Tenant-wide checklist templates (Spec §11): drafts, publishing, the content in the person's language. */
@Controller('inspection/templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplateService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  @Get()
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  list() {
    return this.templates.list({ tenantId: tenantOf(this.ctx, this.actors) }, this.locale.get());
  }

  @Post()
  @RequirePermission('inspection.template.manage', { checkedBy: 'gate' })
  create(@Body() body: CreateTemplateDto) {
    return this.templates.create({ tenantId: tenantOf(this.ctx, this.actors) }, body);
  }

  @Get(':templateId')
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  get(@Param('templateId') id: string, @Query() query: TemplateQueryDto) {
    return this.templates.get(
      { tenantId: tenantOf(this.ctx, this.actors) },
      id,
      this.locale.get(),
      query.versionId,
    );
  }

  @Post(':templateId/versions')
  @RequirePermission('inspection.template.manage', { checkedBy: 'gate' })
  draft(@Param('templateId') id: string, @Body() body: VersionContentDto) {
    return this.templates.draft({ tenantId: tenantOf(this.ctx, this.actors) }, id, body);
  }

  @Post('versions/:versionId/publish')
  @HttpCode(200)
  @RequirePermission('inspection.template.manage', { checkedBy: 'gate' })
  publish(@Param('versionId') versionId: string) {
    return this.templates.publish({ tenantId: tenantOf(this.ctx, this.actors) }, versionId);
  }
}

/** Inspections of a property: start, answer, photos, complete, findings. */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class InspectionsController {
  constructor(
    private readonly inspections: InspectionService,
    private readonly templates: TemplateService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  private scope(propertyId: string) {
    return { tenantId: tenantOf(this.ctx, this.actors), propertyId };
  }

  /** The group's checklists, for the supervisors of this hotel. */
  @Get('inspection-templates')
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  checklists(@Param('propertyId') propertyId: string) {
    return this.templates.list(this.scope(propertyId), this.locale.get());
  }

  @Get('inspections')
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string, @Query() query: ListInspectionsDto) {
    return this.inspections.list(this.scope(propertyId), query, this.locale.get());
  }

  @Post('inspections')
  @RequirePermission('inspection.perform', { checkedBy: 'gate' })
  start(@Param('propertyId') propertyId: string, @Body() body: StartInspectionDto) {
    return this.inspections.start(this.scope(propertyId), body);
  }

  @Get('inspections/:inspectionId')
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  get(@Param('propertyId') propertyId: string, @Param('inspectionId') id: string) {
    return this.inspections.get(this.scope(propertyId), id, this.locale.get());
  }

  @Put('inspections/:inspectionId/answers')
  @RequirePermission('inspection.perform', { checkedBy: 'gate' })
  answer(
    @Param('propertyId') propertyId: string,
    @Param('inspectionId') id: string,
    @Body() body: AnswerItemDto,
  ) {
    return this.inspections.answer(this.scope(propertyId), id, body);
  }

  /** The photo is the raw request body (`image/png`, `image/jpeg` or `image/webp`). */
  @Post('inspections/:inspectionId/photos')
  @RequirePermission('inspection.perform', { checkedBy: 'gate' })
  async addPhoto(
    @Param('propertyId') propertyId: string,
    @Param('inspectionId') id: string,
    @Req() req: IncomingMessage,
  ) {
    return this.inspections.addPhoto(
      this.scope(propertyId),
      id,
      await readBody(req, PHOTO_MAX_BYTES),
    );
  }

  @Get('inspections/:inspectionId/photos/:name')
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  @Header('cache-control', 'private, max-age=300')
  @Header('x-content-type-options', 'nosniff')
  async photo(
    @Param('propertyId') propertyId: string,
    @Param('inspectionId') id: string,
    @Param('name') name: string,
  ) {
    const { body, type } = await this.inspections.photo(this.scope(propertyId), id, name);
    return new StreamableFile(body, { type, length: body.length });
  }

  @Post('inspections/:inspectionId/complete')
  @HttpCode(200)
  @RequirePermission('inspection.perform', { checkedBy: 'gate' })
  complete(@Param('propertyId') propertyId: string, @Param('inspectionId') id: string) {
    return this.inspections.complete(this.scope(propertyId), id);
  }

  @Post('inspections/:inspectionId/cancel')
  @HttpCode(200)
  @RequirePermission('inspection.perform', { checkedBy: 'gate' })
  cancel(@Param('propertyId') propertyId: string, @Param('inspectionId') id: string) {
    return this.inspections.cancel(this.scope(propertyId), id);
  }

  @Get('inspection-findings')
  @RequirePermission('inspection.read', { checkedBy: 'gate' })
  findings(@Param('propertyId') propertyId: string) {
    return this.inspections.openFindings(this.scope(propertyId));
  }

  @Post('inspection-findings/:findingId/work')
  @RequirePermission('inspection.perform', { checkedBy: 'gate' })
  work(@Param('propertyId') propertyId: string, @Param('findingId') id: string) {
    return this.inspections.workForFinding(this.scope(propertyId), id);
  }
}
