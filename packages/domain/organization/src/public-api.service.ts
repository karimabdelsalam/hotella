import { Injectable } from '@nestjs/common';
import { BrandingService } from './application/services';
import { OrganizationRepositories } from './infrastructure/repositories';
import type { OrganizationPublicApi, PropertySummary, ResolvedBrand, RoomSummary } from './public';

@Injectable()
export class OrganizationPublicApiService implements OrganizationPublicApi {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly branding: BrandingService,
  ) {}
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
    return r
      ? {
          id: r.locationId,
          propertyId: r.propertyId,
          roomNumber: r.roomNumber,
          roomTypeId: r.roomTypeId,
        }
      : null;
  }
  resolveBranding(
    propertyId: string,
    channel: string | null,
    locale: string | null,
  ): Promise<ResolvedBrand> {
    return this.branding.resolve(propertyId, channel, locale);
  }
}
