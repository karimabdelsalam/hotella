import { Inject, Injectable, Optional } from '@nestjs/common';
import { ENGINEERING_API, type EngineeringPublicApi } from '@hotella/domain-engineering/public';
import { LOSTFOUND_API, type LostFoundPublicApi } from '@hotella/domain-lostfound/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { RELATIONS_API, type RelationsPublicApi } from '@hotella/domain-relations/public';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { SettingsReader } from '@hotella/platform-settings';
import { SHIFT_STARTS } from '../domain/settings';
import { type Shift, shiftAt, shiftWindow } from '../domain/shifts';
import { LogbookRepositories } from '../infrastructure/repositories';
import type { EntryRow, HandoverFacts } from '../infrastructure/schema';

/**
 * The facts of a shift (BUILD_PLAN 9.B): counted here, from the owning contexts' public APIs, never by a model. The
 * handover stores exactly what it was built from. A context the deployment does not compose is left out (null).
 */
@Injectable()
export class FactsService {
  constructor(
    private readonly repo: LogbookRepositories,
    private readonly settings: SettingsReader,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Optional() @Inject(RELATIONS_API) private readonly relations?: RelationsPublicApi,
    @Optional() @Inject(ENGINEERING_API) private readonly engineering?: EngineeringPublicApi,
    @Optional() @Inject(LOSTFOUND_API) private readonly lostfound?: LostFoundPublicApi,
  ) {}

  /** The shift running now at the property. */
  async current(scope: PropertyScope, now = new Date()) {
    const { timeZone, starts } = await this.clock(scope);
    const s = shiftAt(now, timeZone, starts);
    return { ...s, ...shiftWindow(s.shiftDate, s.shift, timeZone, starts) };
  }

  async window(scope: PropertyScope, shiftDate: string, shift: Shift) {
    const { timeZone, starts } = await this.clock(scope);
    return shiftWindow(shiftDate, shift, timeZone, starts);
  }

  async collect(
    scope: PropertyScope,
    departmentCode: string,
    shiftDate: string,
    shift: Shift,
  ): Promise<{ facts: HandoverFacts; entries: EntryRow[] }> {
    const window = await this.window(scope, shiftDate, shift);
    const entries = await this.repo.entriesOf(scope, departmentCode, shiftDate, shift);
    const work = (await this.ops.openWorkSummary(scope.tenantId, scope.propertyId)).find(
      (w) => w.departmentCode === departmentCode,
    );
    const complaints = this.relations
      ? await this.relations.openComplaints(scope.tenantId, scope.propertyId)
      : null;
    const restrictions = this.engineering
      ? await this.engineering.activeRestrictions(scope.tenantId, scope.propertyId)
      : null;
    const rooms = restrictions?.length
      ? new Map(
          (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [
            r.id,
            r.roomNumber,
          ]),
        )
      : new Map<string, string>();
    const lf = this.lostfound
      ? await this.lostfound.openCounts(scope.tenantId, scope.propertyId)
      : null;
    return {
      entries,
      facts: {
        department: departmentCode,
        shift_date: shiftDate,
        shift,
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        work: { open: work?.open ?? 0, urgent: work?.urgent ?? 0, overdue: work?.overdue ?? 0 },
        complaints: complaints
          ? {
              open: complaints.length,
              high_or_critical: complaints.filter(
                (c) => c.severity === 'HIGH' || c.severity === 'CRITICAL',
              ).length,
            }
          : null,
        rooms_out_of_order: restrictions
          ? restrictions
              .map((r) => ({ room: rooms.get(r.roomId) ?? '?', kind: r.kind }))
              .sort((a, b) => a.room.localeCompare(b.room, 'en', { numeric: true }))
          : null,
        lost_found: lf
          ? {
              found_waiting: lf.found,
              lost_reports_open: lf.lost,
              matches_to_decide: lf.proposedMatches,
              past_retention: lf.retentionDue,
            }
          : null,
        entries: {
          total: entries.length,
          incidents: entries.filter((e) => e.kind === 'INCIDENT').length,
        },
      },
    };
  }

  private async clock(scope: PropertyScope) {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    if (!property) throw AppError.notFound('org.property.not_found');
    return { timeZone: property.timezone, starts: await this.settings.value(SHIFT_STARTS, scope) };
  }
}
