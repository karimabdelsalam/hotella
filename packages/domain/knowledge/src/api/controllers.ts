import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  archiveSchema,
  createDocumentSchema,
  createVersionSchema,
  KnowledgeAdminService,
  searchSchema,
} from '../application/admin.service';

class CreateDocumentDto extends createZodDto(createDocumentSchema) {}
class CreateVersionDto extends createZodDto(createVersionSchema) {}
class ArchiveDto extends createZodDto(archiveSchema) {}
class SearchDto extends createZodDto(searchSchema) {}

/** Hotel knowledge of a property and of its tenant (BUILD_PLAN 6.D). */
@Controller('properties/:propertyId/knowledge')
@PropertyScoped({ from: 'param' })
export class KnowledgeController {
  constructor(
    private readonly admin: KnowledgeAdminService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.property.not_found');
    return { tenantId, propertyId };
  }

  @Get('documents')
  @RequirePermission('knowledge.read')
  list(@Param('propertyId') propertyId: string) {
    return this.admin.list(this.scope(propertyId));
  }

  @Post('documents')
  @RequirePermission('knowledge.manage', { checkedBy: 'gate' })
  create(@Param('propertyId') propertyId: string, @Body() body: CreateDocumentDto) {
    return this.admin.createDocument(this.scope(propertyId), body);
  }

  @Post('documents/:documentId/archive')
  @HttpCode(200)
  @RequirePermission('knowledge.manage', { checkedBy: 'gate' })
  archive(
    @Param('propertyId') propertyId: string,
    @Param('documentId') documentId: string,
    @Body() body: ArchiveDto,
  ) {
    return this.admin.archive(this.scope(propertyId), documentId, body);
  }

  @Post('documents/:documentId/versions')
  @RequirePermission('knowledge.manage', { checkedBy: 'gate' })
  addVersion(
    @Param('propertyId') propertyId: string,
    @Param('documentId') documentId: string,
    @Body() body: CreateVersionDto,
  ) {
    return this.admin.addVersion(this.scope(propertyId), documentId, body);
  }

  @Get('documents/:documentId/versions/:versionId')
  @RequirePermission('knowledge.read')
  version(
    @Param('propertyId') propertyId: string,
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.admin.version(this.scope(propertyId), documentId, versionId);
  }

  @Post('documents/:documentId/versions/:versionId/publish')
  @HttpCode(200)
  @RequirePermission('knowledge.manage', { checkedBy: 'gate' })
  publish(
    @Param('propertyId') propertyId: string,
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.admin.publish(this.scope(propertyId), documentId, versionId);
  }

  @Post('search')
  @HttpCode(200)
  @RequirePermission('knowledge.read')
  search(@Param('propertyId') propertyId: string, @Body() body: SearchDto) {
    return this.admin.search(this.scope(propertyId), body);
  }
}
