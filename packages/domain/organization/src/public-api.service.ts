import { Injectable } from '@nestjs/common';
import { isUuid } from '@hotella/platform-database';
import { BrandingService } from './application/services';
import { OrganizationRepositories } from './infrastructure/repositories';
import { normalizeCode } from './domain/values';
import type { RoomRow, TenantRow } from './infrastructure/schema';
import type {
  DepartmentSummary,
  LocationSummary,
  OrganizationPublicApi,
  PropertySummary,
  ResolvedBrand,
  RoomSummary,
  TenantSummary,
} from './public';

function toTenantSummary(t: TenantRow): TenantSummary {
  return { id: t.id, code: t.code, name: t.name, status: t.status, defaultLocale: t.defaultLocale };
}

function toRoomSummary(r: RoomRow): RoomSummary {
  return {
    id: r.locationId,
    propertyId: r.propertyId,
    roomNumber: r.roomNumber,
    roomTypeId: r.roomTypeId,
  };
}

@Injectable()
export class OrganizationPublicApiService implements OrganizationPublicApi {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly branding: BrandingService,
  ) {}
  async findTenantByCode(code: string): Promise<TenantSummary | null> {
    let normalized: string;
    try {
      normalized = normalizeCode(code);
    } catch {
      return null;
    }
    const t = await this.repo.tenantByCode(normalized);
    return t ? toTenantSummary(t) : null;
  }
  async getTenant(tenantId: string): Promise<TenantSummary | null> {
    const t = await this.repo.tenantById(tenantId);
    return t ? toTenantSummary(t) : null;
  }
  async findPropertyTenant(propertyId: string): Promise<string | null> {
    return (await this.repo.propertyByIdUnscoped(propertyId))?.tenantId ?? null;
  }
  async getProperty(tenantId: string, propertyId: string): Promise<PropertySummary | null> {
    const p = await this.repo.propertyById({ tenantId }, propertyId);
    return p
      ? {
          id: p.id,
          tenantId: p.tenantId,
          organizationId: p.organizationId,
          code: p.code,
          name: p.name,
          timezone: p.timezone,
          currency: p.currency,
          defaultLocale: p.defaultLocale,
          enabledLocales: p.enabledLocales,
          status: p.status,
        }
      : null;
  }
  async listProperties(tenantId: string): Promise<readonly PropertySummary[]> {
    return (await this.repo.listProperties({ tenantId })).map((p) => ({
      id: p.id,
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      code: p.code,
      name: p.name,
      timezone: p.timezone,
      currency: p.currency,
      defaultLocale: p.defaultLocale,
      enabledLocales: p.enabledLocales,
      status: p.status,
    }));
  }
  async getRoomByNumber(
    tenantId: string,
    propertyId: string,
    roomNumber: string,
  ): Promise<RoomSummary | null> {
    const r = await this.repo.roomByNumber({ tenantId, propertyId }, roomNumber);
    return r ? toRoomSummary(r) : null;
  }
  async getRoom(tenantId: string, propertyId: string, roomId: string): Promise<RoomSummary | null> {
    const r = await this.repo.roomById({ tenantId, propertyId }, roomId);
    return r ? toRoomSummary(r) : null;
  }
  async listRooms(tenantId: string, propertyId: string): Promise<readonly RoomSummary[]> {
    return (await this.repo.listRooms({ tenantId, propertyId })).map(toRoomSummary);
  }
  async getLocation(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<LocationSummary | null> {
    if (!isUuid(locationId)) return null;
    const l = await this.repo.locationById({ tenantId, propertyId }, locationId);
    return l
      ? { id: l.id, propertyId: l.propertyId, kind: l.kind, code: l.code, status: l.status }
      : null;
  }
  async getDepartment(
    tenantId: string,
    propertyId: string,
    code: string,
  ): Promise<DepartmentSummary | null> {
    const d = await this.repo.departmentByCode({ tenantId, propertyId }, code.trim().toUpperCase());
    return d ? { id: d.id, propertyId: d.propertyId, code: d.code, status: d.status } : null;
  }
  resolveBranding(
    propertyId: string,
    channel: string | null,
    locale: string | null,
  ): Promise<ResolvedBrand> {
    return this.branding.resolve(propertyId, channel, locale);
  }
}
