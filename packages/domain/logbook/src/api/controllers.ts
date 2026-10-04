import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { ActorStore, PropertyScoped, RequirePermission } from '@hotella/platform-auth';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  acknowledgeSchema,
  addEntrySchema,
  draftHandoverSchema,
  editHandoverSchema,
  listHandoversSchema,
  LogbookService,
  shiftQuerySchema,
} from '../application/logbook.service';

class AddEntryDto extends createZodDto(addEntrySchema) {}
class ShiftQueryDto extends createZodDto(shiftQuerySchema) {}
class DraftHandoverDto extends createZodDto(draftHandoverSchema) {}
class EditHandoverDto extends createZodDto(editHandoverSchema) {}
class AcknowledgeDto extends createZodDto(acknowledgeSchema) {}
class ListHandoversDto extends createZodDto(listHandoversSchema) {}

/** The logbook of a property: shift entries and handovers. */
@Controller('properties/:propertyId/logbook')
@PropertyScoped({ from: 'param' })
export class LogbookController {
  constructor(
    private readonly logbook: LogbookService,
    private readonly ctx: RequestContext,
    private readonly actors: ActorStore,
    private readonly locale: CurrentLocale,
  ) {}

  private scope(propertyId: string) {
    const tenantId = this.ctx.tenantId ?? this.actors.require().tenantId;
    if (!tenantId) throw AppError.notFound('org.tenant.not_found');
    return { tenantId, propertyId };
  }

  /** A shift of a department (the running one by default) with its entries, facts and handover. */
  @Get('shift')
  @RequirePermission('logbook.read', { checkedBy: 'gate' })
  shift(@Param('propertyId') propertyId: string, @Query() query: ShiftQueryDto) {
    return this.logbook.shift(this.scope(propertyId), query);
  }

  @Post('entries')
  @RequirePermission('logbook.write', { checkedBy: 'gate' })
  addEntry(@Param('propertyId') propertyId: string, @Body() body: AddEntryDto) {
    return this.logbook.addEntry(this.scope(propertyId), body);
  }

  @Get('handovers')
  @RequirePermission('logbook.read', { checkedBy: 'gate' })
  handovers(@Param('propertyId') propertyId: string, @Query() query: ListHandoversDto) {
    return this.logbook.handovers(this.scope(propertyId), query);
  }

  @Post('handovers')
  @HttpCode(200)
  @RequirePermission('logbook.write', { checkedBy: 'gate' })
  draft(@Param('propertyId') propertyId: string, @Body() body: DraftHandoverDto) {
    return this.logbook.draftHandover(this.scope(propertyId), body, this.locale.get());
  }

  @Put('handovers/:handoverId')
  @RequirePermission('logbook.write', { checkedBy: 'gate' })
  edit(
    @Param('propertyId') propertyId: string,
    @Param('handoverId') id: string,
    @Body() body: EditHandoverDto,
  ) {
    return this.logbook.editHandover(this.scope(propertyId), id, body);
  }

  @Post('handovers/:handoverId/acknowledge')
  @HttpCode(200)
  @RequirePermission('logbook.handover.acknowledge', { checkedBy: 'gate' })
  acknowledge(
    @Param('propertyId') propertyId: string,
    @Param('handoverId') id: string,
    @Body() body: AcknowledgeDto,
  ) {
    return this.logbook.acknowledge(this.scope(propertyId), id, body);
  }
}
