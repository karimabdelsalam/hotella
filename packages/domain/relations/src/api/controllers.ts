import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  CandidateService,
  confirmCandidateSchema,
  dismissCandidateSchema,
} from '../application/candidate.service';
import {
  ComplaintService,
  createCategorySchema,
  listComplaintsSchema,
  moveComplaintSchema,
  noteSchema,
  openComplaintSchema,
} from '../application/complaint.service';
import { addRecoverySchema, RecoveryService } from '../application/recovery.service';

class CreateCategoryDto extends createZodDto(createCategorySchema) {}
class OpenComplaintDto extends createZodDto(openComplaintSchema) {}
class MoveComplaintDto extends createZodDto(moveComplaintSchema) {}
class NoteDto extends createZodDto(noteSchema) {}
class ListComplaintsDto extends createZodDto(listComplaintsSchema) {}
class ConfirmCandidateDto extends createZodDto(confirmCandidateSchema) {}
class DismissCandidateDto extends createZodDto(dismissCandidateSchema) {}
class AddRecoveryDto extends createZodDto(addRecoverySchema) {}

function tenantOf(ctx: RequestContext, actors: ActorStore): string {
  const tenantId = ctx.tenantId ?? actors.require().tenantId;
  if (!tenantId) throw AppError.notFound('org.tenant.not_found');
  return tenantId;
}

/** Tenant-wide complaint categories (names per language, default severity, owning department). */
@Controller('relations/categories')
export class CategoriesController {
  constructor(
    private readonly complaints: ComplaintService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  @Get()
  @RequirePermission('complaint.read', { checkedBy: 'gate' })
  list() {
    return this.complaints.listCategories(
      { tenantId: tenantOf(this.ctx, this.actors) },
      this.locale.get(),
    );
  }

  @Post()
  @RequirePermission('complaint.category.manage', { checkedBy: 'gate' })
  create(@Body() body: CreateCategoryDto) {
    return this.complaints.createCategory({ tenantId: tenantOf(this.ctx, this.actors) }, body);
  }

  /** Adds the starter categories (English and Arabic) the tenant does not have yet. */
  @Post('starter')
  @HttpCode(200)
  @RequirePermission('complaint.category.manage', { checkedBy: 'gate' })
  starter() {
    return this.complaints.importStarter({ tenantId: tenantOf(this.ctx, this.actors) });
  }
}

/** Complaints of a property, the AI's candidates and service recovery. */
@Controller('properties/:propertyId')
@PropertyScoped({ from: 'param' })
export class ComplaintsController {
  constructor(
    private readonly complaints: ComplaintService,
    private readonly candidates: CandidateService,
    private readonly recovery: RecoveryService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  private scope(propertyId: string) {
    return { tenantId: tenantOf(this.ctx, this.actors), propertyId };
  }

  /** The group's categories, for the desk of this hotel. */
  @Get('complaint-categories')
  @RequirePermission('complaint.read', { checkedBy: 'gate' })
  categories(@Param('propertyId') propertyId: string) {
    return this.complaints.listCategories(this.scope(propertyId), this.locale.get());
  }

  @Get('complaints')
  @RequirePermission('complaint.read', { checkedBy: 'gate' })
  list(@Param('propertyId') propertyId: string, @Query() query: ListComplaintsDto) {
    return this.complaints.list(this.scope(propertyId), query, this.locale.get());
  }

  @Post('complaints')
  @RequirePermission('complaint.manage', { checkedBy: 'gate' })
  open(@Param('propertyId') propertyId: string, @Body() body: OpenComplaintDto) {
    return this.complaints.open(this.scope(propertyId), body);
  }

  @Get('complaints/:complaintId')
  @RequirePermission('complaint.read', { checkedBy: 'gate' })
  get(@Param('propertyId') propertyId: string, @Param('complaintId') id: string) {
    return this.complaints.get(this.scope(propertyId), id, this.locale.get());
  }

  @Post('complaints/:complaintId/status')
  @HttpCode(200)
  @RequirePermission('complaint.manage', { checkedBy: 'gate' })
  move(
    @Param('propertyId') propertyId: string,
    @Param('complaintId') id: string,
    @Body() body: MoveComplaintDto,
  ) {
    return this.complaints.move(this.scope(propertyId), id, body);
  }

  @Post('complaints/:complaintId/notes')
  @RequirePermission('complaint.manage', { checkedBy: 'gate' })
  note(
    @Param('propertyId') propertyId: string,
    @Param('complaintId') id: string,
    @Body() body: NoteDto,
  ) {
    return this.complaints.addNote(this.scope(propertyId), id, body);
  }

  @Post('complaints/:complaintId/recovery')
  @RequirePermission('complaint.recovery.manage', { checkedBy: 'gate' })
  addRecovery(
    @Param('propertyId') propertyId: string,
    @Param('complaintId') id: string,
    @Body() body: AddRecoveryDto,
  ) {
    return this.recovery.add(this.scope(propertyId), id, body);
  }

  @Get('complaint-candidates')
  @RequirePermission('complaint.read', { checkedBy: 'gate' })
  candidatesList(@Param('propertyId') propertyId: string) {
    return this.candidates.list(this.scope(propertyId), this.locale.get());
  }

  @Post('complaint-candidates/:candidateId/confirm')
  @RequirePermission('complaint.manage', { checkedBy: 'gate' })
  confirm(
    @Param('propertyId') propertyId: string,
    @Param('candidateId') id: string,
    @Body() body: ConfirmCandidateDto,
  ) {
    return this.candidates.confirm(this.scope(propertyId), id, body);
  }

  @Post('complaint-candidates/:candidateId/dismiss')
  @HttpCode(200)
  @RequirePermission('complaint.manage', { checkedBy: 'gate' })
  dismiss(
    @Param('propertyId') propertyId: string,
    @Param('candidateId') id: string,
    @Body() body: DismissCandidateDto,
  ) {
    return this.candidates.dismiss(this.scope(propertyId), id, body);
  }
}
