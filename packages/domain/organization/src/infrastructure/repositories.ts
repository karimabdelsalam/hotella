import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  brandProfiles,
  brandProfileTranslations,
  locations,
  locationTranslations,
  organizations,
  properties,
  rooms,
  departments,
  departmentTranslations,
  roomTypes,
  roomTypeTranslations,
  tenants,
  type BrandProfileRow,
  type LocationRow,
  type OrganizationRow,
  type PropertyRow,
  type RoomRow,
  type DepartmentRow,
  type RoomTypeRow,
  type TenantRow,
} from './schema';

/** Repositories never accept a query without a tenant/property scope (CLAUDE.md rule 1). */
@Injectable()
export class OrganizationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- tenants (platform level; no tenant filter by definition) ----
  async insertTenant(values: typeof tenants.$inferInsert): Promise<TenantRow> {
    const [row] = await this.x.insert(tenants).values(values).returning();
    return row!;
  }
  tenantById(id: string): Promise<TenantRow | undefined> {
    return this.x
      .select()
      .from(tenants)
      .where(eq(tenants.id, id))
      .then((r) => r[0]);
  }
  tenantByCode(code: string): Promise<TenantRow | undefined> {
    return this.x
      .select()
      .from(tenants)
      .where(eq(tenants.code, code))
      .then((r) => r[0]);
  }
  listTenants(): Promise<TenantRow[]> {
    return this.x.select().from(tenants).orderBy(asc(tenants.code));
  }

  // ---- organizations ----
  async insertOrganization(values: typeof organizations.$inferInsert): Promise<OrganizationRow> {
    const [row] = await this.x.insert(organizations).values(values).returning();
    return row!;
  }
  organizationById(scope: TenantScope, id: string): Promise<OrganizationRow | undefined> {
    return this.x
      .select()
      .from(organizations)
      .where(tenantWhere(organizations, scope, eq(organizations.id, id)))
      .then((r) => r[0]);
  }
  organizationByCode(scope: TenantScope, code: string): Promise<OrganizationRow | undefined> {
    return this.x
      .select()
      .from(organizations)
      .where(tenantWhere(organizations, scope, eq(organizations.code, code)))
      .then((r) => r[0]);
  }
  listOrganizations(scope: TenantScope): Promise<OrganizationRow[]> {
    return this.x
      .select()
      .from(organizations)
      .where(tenantWhere(organizations, scope))
      .orderBy(asc(organizations.code));
  }

  // ---- properties ----
  async insertProperty(values: typeof properties.$inferInsert): Promise<PropertyRow> {
    const [row] = await this.x.insert(properties).values(values).returning();
    return row!;
  }
  propertyById(scope: TenantScope, id: string): Promise<PropertyRow | undefined> {
    return this.x
      .select()
      .from(properties)
      .where(tenantWhere(properties, scope, eq(properties.id, id)))
      .then((r) => r[0]);
  }
  /** Public branding resolution knows only the property id (QR, guest links): no tenant yet. */
  propertyByIdUnscoped(id: string): Promise<PropertyRow | undefined> {
    return this.x
      .select()
      .from(properties)
      .where(eq(properties.id, id))
      .then((r) => r[0]);
  }
  propertyByCode(scope: TenantScope, code: string): Promise<PropertyRow | undefined> {
    return this.x
      .select()
      .from(properties)
      .where(tenantWhere(properties, scope, eq(properties.code, code)))
      .then((r) => r[0]);
  }
  listProperties(scope: TenantScope): Promise<PropertyRow[]> {
    return this.x
      .select()
      .from(properties)
      .where(tenantWhere(properties, scope))
      .orderBy(asc(properties.code));
  }
  async updateProperty(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<typeof properties.$inferInsert>,
  ): Promise<PropertyRow | undefined> {
    const [row] = await this.x
      .update(properties)
      .set({ ...patch, version: sql`${properties.version} + 1` })
      .where(
        tenantWhere(
          properties,
          scope,
          eq(properties.id, id),
          eq(properties.version, expectedVersion),
        ),
      )
      .returning();
    return row;
  }

  // ---- locations ----
  async insertLocation(values: typeof locations.$inferInsert): Promise<LocationRow> {
    const [row] = await this.x.insert(locations).values(values).returning();
    return row!;
  }
  locationById(scope: PropertyScope, id: string): Promise<LocationRow | undefined> {
    return this.x
      .select()
      .from(locations)
      .where(propertyWhere(locations, scope, eq(locations.id, id)))
      .then((r) => r[0]);
  }
  locationByParentAndCode(
    scope: PropertyScope,
    parentId: string | null,
    code: string,
  ): Promise<LocationRow | undefined> {
    return this.x
      .select()
      .from(locations)
      .where(
        propertyWhere(
          locations,
          scope,
          parentId ? eq(locations.parentId, parentId) : isNull(locations.parentId),
          eq(locations.code, code),
        ),
      )
      .then((r) => r[0]);
  }
  listLocations(scope: PropertyScope): Promise<LocationRow[]> {
    return this.x
      .select()
      .from(locations)
      .where(propertyWhere(locations, scope))
      .orderBy(asc(locations.path), asc(locations.sortOrder));
  }
  async upsertLocationTranslations(
    locationId: string,
    translations: ReadonlyArray<{ locale: string; name: string; description?: string | null }>,
  ): Promise<void> {
    if (translations.length === 0) return;
    await this.x
      .insert(locationTranslations)
      .values(
        translations.map((t) => ({
          entityId: locationId,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [locationTranslations.entityId, locationTranslations.locale],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          updatedAt: sql`now()`,
        },
      });
  }
  locationTranslationsFor(
    locationIds: readonly string[],
  ): Promise<
    Array<{ entityId: string; locale: string; name: string; description: string | null }>
  > {
    if (locationIds.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        entityId: locationTranslations.entityId,
        locale: locationTranslations.locale,
        name: locationTranslations.name,
        description: locationTranslations.description,
      })
      .from(locationTranslations)
      .where(inArray(locationTranslations.entityId, [...locationIds]));
  }

  // ---- room types ----
  async insertRoomType(values: typeof roomTypes.$inferInsert): Promise<RoomTypeRow> {
    const [row] = await this.x.insert(roomTypes).values(values).returning();
    return row!;
  }
  roomTypeById(scope: PropertyScope, id: string): Promise<RoomTypeRow | undefined> {
    return this.x
      .select()
      .from(roomTypes)
      .where(propertyWhere(roomTypes, scope, eq(roomTypes.id, id)))
      .then((r) => r[0]);
  }
  roomTypeByCode(scope: PropertyScope, code: string): Promise<RoomTypeRow | undefined> {
    return this.x
      .select()
      .from(roomTypes)
      .where(propertyWhere(roomTypes, scope, eq(roomTypes.code, code)))
      .then((r) => r[0]);
  }
  listRoomTypes(scope: PropertyScope): Promise<RoomTypeRow[]> {
    return this.x
      .select()
      .from(roomTypes)
      .where(propertyWhere(roomTypes, scope))
      .orderBy(asc(roomTypes.code));
  }
  async upsertRoomTypeTranslations(
    roomTypeId: string,
    translations: ReadonlyArray<{ locale: string; name: string; description?: string | null }>,
  ): Promise<void> {
    if (translations.length === 0) return;
    await this.x
      .insert(roomTypeTranslations)
      .values(
        translations.map((t) => ({
          entityId: roomTypeId,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [roomTypeTranslations.entityId, roomTypeTranslations.locale],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          updatedAt: sql`now()`,
        },
      });
  }
  roomTypeTranslationsFor(
    ids: readonly string[],
  ): Promise<Array<{ entityId: string; locale: string; name: string }>> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        entityId: roomTypeTranslations.entityId,
        locale: roomTypeTranslations.locale,
        name: roomTypeTranslations.name,
      })
      .from(roomTypeTranslations)
      .where(inArray(roomTypeTranslations.entityId, [...ids]));
  }

  // ---- departments ----
  async insertDepartment(values: typeof departments.$inferInsert): Promise<DepartmentRow> {
    const [row] = await this.x.insert(departments).values(values).returning();
    return row!;
  }
  departmentByCode(scope: PropertyScope, code: string): Promise<DepartmentRow | undefined> {
    return this.x
      .select()
      .from(departments)
      .where(propertyWhere(departments, scope, eq(departments.code, code)))
      .then((r) => r[0]);
  }
  listDepartments(scope: PropertyScope): Promise<DepartmentRow[]> {
    return this.x
      .select()
      .from(departments)
      .where(propertyWhere(departments, scope))
      .orderBy(asc(departments.code));
  }
  async upsertDepartmentTranslations(
    departmentId: string,
    translations: ReadonlyArray<{ locale: string; name: string; description?: string | null }>,
  ): Promise<void> {
    if (translations.length === 0) return;
    await this.x
      .insert(departmentTranslations)
      .values(
        translations.map((t) => ({
          entityId: departmentId,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [departmentTranslations.entityId, departmentTranslations.locale],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          updatedAt: sql`now()`,
        },
      });
  }
  departmentTranslationsFor(
    ids: readonly string[],
  ): Promise<Array<{ entityId: string; locale: string; name: string }>> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        entityId: departmentTranslations.entityId,
        locale: departmentTranslations.locale,
        name: departmentTranslations.name,
      })
      .from(departmentTranslations)
      .where(inArray(departmentTranslations.entityId, [...ids]));
  }

  // ---- rooms ----
  async insertRoom(values: typeof rooms.$inferInsert): Promise<RoomRow> {
    const [row] = await this.x.insert(rooms).values(values).returning();
    return row!;
  }
  roomByNumber(scope: PropertyScope, roomNumber: string): Promise<RoomRow | undefined> {
    return this.x
      .select()
      .from(rooms)
      .where(propertyWhere(rooms, scope, eq(rooms.roomNumber, roomNumber)))
      .then((r) => r[0]);
  }
  roomById(scope: PropertyScope, locationId: string): Promise<RoomRow | undefined> {
    return this.x
      .select()
      .from(rooms)
      .where(propertyWhere(rooms, scope, eq(rooms.locationId, locationId)))
      .then((r) => r[0]);
  }
  listRooms(scope: PropertyScope): Promise<RoomRow[]> {
    return this.x
      .select()
      .from(rooms)
      .where(propertyWhere(rooms, scope))
      .orderBy(asc(rooms.roomNumber));
  }

  // ---- brand profiles ----
  brandProfilesForTenant(scope: TenantScope): Promise<BrandProfileRow[]> {
    return this.x
      .select()
      .from(brandProfiles)
      .where(tenantWhere(brandProfiles, scope))
      .orderBy(asc(brandProfiles.scope));
  }
  brandProfile(
    scope: TenantScope,
    brandScope: BrandProfileRow['scope'],
    scopeId: string,
    channel: string | null,
  ): Promise<BrandProfileRow | undefined> {
    return this.x
      .select()
      .from(brandProfiles)
      .where(
        tenantWhere(
          brandProfiles,
          scope,
          eq(brandProfiles.scope, brandScope),
          eq(brandProfiles.scopeId, scopeId),
          channel ? eq(brandProfiles.channel, channel) : isNull(brandProfiles.channel),
        ),
      )
      .then((r) => r[0]);
  }
  async upsertBrandProfile(values: typeof brandProfiles.$inferInsert): Promise<BrandProfileRow> {
    const [row] = await this.x
      .insert(brandProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: [
          brandProfiles.tenantId,
          brandProfiles.scope,
          brandProfiles.scopeId,
          brandProfiles.channel,
        ],
        set: {
          displayName: sql`excluded.display_name`,
          logoAssetKey: sql`excluded.logo_asset_key`,
          logoAltAssetKey: sql`excluded.logo_alt_asset_key`,
          primaryColor: sql`excluded.primary_color`,
          secondaryColor: sql`excluded.secondary_color`,
          coverAssetKeys: sql`excluded.cover_asset_keys`,
          faviconAssetKey: sql`excluded.favicon_asset_key`,
          typography: sql`excluded.typography`,
          contact: sql`excluded.contact`,
          social: sql`excluded.social`,
          aiPersona: sql`excluded.ai_persona`,
          presentation: sql`excluded.presentation`,
          updatedAt: sql`now()`,
          version: sql`${brandProfiles.version} + 1`,
        },
      })
      .returning();
    return row!;
  }
  async upsertBrandTranslations(
    id: string,
    translations: ReadonlyArray<{
      locale: string;
      welcomeText?: string | null;
      farewellText?: string | null;
    }>,
  ): Promise<void> {
    if (translations.length === 0) return;
    await this.x
      .insert(brandProfileTranslations)
      .values(
        translations.map((t) => ({
          entityId: id,
          locale: t.locale,
          welcomeText: t.welcomeText ?? null,
          farewellText: t.farewellText ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [brandProfileTranslations.entityId, brandProfileTranslations.locale],
        set: {
          welcomeText: sql`excluded.welcome_text`,
          farewellText: sql`excluded.farewell_text`,
          updatedAt: sql`now()`,
        },
      });
  }
  brandTranslations(ids: readonly string[]): Promise<
    Array<{
      entityId: string;
      locale: string;
      welcomeText: string | null;
      farewellText: string | null;
    }>
  > {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        entityId: brandProfileTranslations.entityId,
        locale: brandProfileTranslations.locale,
        welcomeText: brandProfileTranslations.welcomeText,
        farewellText: brandProfileTranslations.farewellText,
      })
      .from(brandProfileTranslations)
      .where(inArray(brandProfileTranslations.entityId, [...ids]));
  }
  /** All layers that can apply to a property, in one round trip. */
  brandLayersForProperty(
    scope: TenantScope,
    organizationId: string | null,
    propertyId: string,
    channel: string | null,
  ): Promise<BrandProfileRow[]> {
    const ids = [scope.tenantId, propertyId, ...(organizationId ? [organizationId] : [])];
    return this.x
      .select()
      .from(brandProfiles)
      .where(
        tenantWhere(
          brandProfiles,
          scope,
          inArray(brandProfiles.scopeId, ids),
          channel
            ? sql`(${brandProfiles.channel} IS NULL OR ${brandProfiles.channel} = ${channel})`
            : isNull(brandProfiles.channel),
        ),
      );
  }
  /** Helper for `and` import users. */
  protected and = and;
}
