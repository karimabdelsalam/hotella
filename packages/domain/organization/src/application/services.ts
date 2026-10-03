import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BrandProfileUpdated,
  LocationCreated,
  PropertyCreated,
  PropertyUpdated,
  RoomCreated,
  TenantCreated,
} from '@hotella/contracts-events';
import { ActionGate, ActorStore, type RequestActor } from '@hotella/platform-auth';
import {
  ltreeLabel,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { AuditWriter } from '@hotella/platform-audit';
import { AttributionPolicyService } from '@hotella/platform-settings';
import { EventPublisher } from '@hotella/platform-events';
import { AppError, CurrentLocale } from '@hotella/platform-i18n';
import { mergeBrand, type BrandLayer, type ResolvedBrand } from '../domain/branding';
import { CONTAINER_KINDS, normalizeCode } from '../domain/values';
import { OrganizationRepositories } from '../infrastructure/repositories';
import type {
  BrandProfileRow,
  LocationRow,
  PropertyRow,
  RoomRow,
  RoomTypeRow,
  TenantRow,
} from '../infrastructure/schema';
import type {
  CreateLocationInput,
  CreateOrganizationInput,
  CreatePropertyInput,
  CreateRoomInput,
  CreateRoomTypeInput,
  CreateTenantInput,
  UpdatePropertyInput,
  UpsertBrandProfileInput,
} from './dto';

export interface LocationNode {
  id: string;
  parentId: string | null;
  kind: LocationRow['kind'];
  code: string;
  path: string;
  name: string;
  sortOrder: number;
  status: LocationRow['status'];
  room: {
    roomNumber: string;
    roomTypeId: string | null;
    roomTypeName: string | null;
    bedConfig: string | null;
  } | null;
  children: LocationNode[];
}

/** Resolves which tenant a request acts on: tenant users → their own; platform admins → the named one. */
export function resolveTenantId(actor: RequestActor, named?: string | null): string {
  if (actor.tenantId) {
    if (named && named !== actor.tenantId) throw AppError.notFound('org.tenant.not_found');
    return actor.tenantId;
  }
  if (!named)
    throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
  return named;
}

@Injectable()
export class TenantService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
  ) {}

  create(input: CreateTenantInput): Promise<TenantRow> {
    return this.gate.execute({ action: 'org.tenant.manage', tenantId: null }, () =>
      this.tx.run(async () => {
        const code = normalizeCode(input.code);
        if (await this.repo.tenantByCode(code))
          throw AppError.conflict('org.tenant.code_taken', { code });
        const row = await this.repo.insertTenant({
          id: newId(),
          code,
          name: input.name,
          defaultLocale: input.defaultLocale,
          defaultTimezone: input.defaultTimezone,
          defaultCurrency: input.defaultCurrency,
          settings: input.settings,
        });
        await this.events.publish(TenantCreated, {
          tenantId: row.id,
          source: 'org',
          aggregate: { type: 'tenant', id: row.id },
          payload: {
            tenant_id: row.id,
            code: row.code,
            name: row.name,
            default_locale: row.defaultLocale,
          },
        });
        await this.audit.record({
          action: 'org.tenant.create',
          entityType: 'tenant',
          entityId: row.id,
          tenantId: row.id,
          after: row,
        });
        return row;
      }),
    );
  }
  async get(id: string): Promise<TenantRow> {
    const row = await this.repo.tenantById(id);
    if (!row) throw AppError.notFound('org.tenant.not_found');
    return row;
  }
  list(): Promise<TenantRow[]> {
    return this.repo.listTenants();
  }
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}
  create(scope: TenantScope, input: CreateOrganizationInput) {
    return this.gate.execute({ action: 'org.tenant.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const code = normalizeCode(input.code);
        if (await this.repo.organizationByCode(scope, code))
          throw AppError.conflict('org.tenant.code_taken', { code });
        if (input.parentId && !(await this.repo.organizationById(scope, input.parentId)))
          throw AppError.notFound('org.organization.not_found');
        const row = await this.repo.insertOrganization({
          id: newId(),
          tenantId: scope.tenantId,
          parentId: input.parentId ?? null,
          code,
          name: input.name,
          legalName: input.legalName ?? null,
          type: input.type,
          settings: input.settings,
        });
        await this.audit.record({
          action: 'org.organization.create',
          entityType: 'organization',
          entityId: row.id,
          tenantId: scope.tenantId,
          after: row,
        });
        return row;
      }),
    );
  }
  list(scope: TenantScope) {
    return this.repo.listOrganizations(scope);
  }
}

@Injectable()
export class PropertyService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
  ) {}

  create(scope: TenantScope, input: CreatePropertyInput): Promise<PropertyRow> {
    return this.gate.execute({ action: 'org.property.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const code = normalizeCode(input.code);
        if (await this.repo.propertyByCode(scope, code))
          throw AppError.conflict('org.property.code_taken', { code });
        if (
          input.organizationId &&
          !(await this.repo.organizationById(scope, input.organizationId))
        )
          throw AppError.notFound('org.organization.not_found');
        if (!input.enabledLocales.includes(input.defaultLocale))
          throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
        const row = await this.repo.insertProperty({
          id: newId(),
          tenantId: scope.tenantId,
          organizationId: input.organizationId ?? null,
          code,
          name: input.name,
          timezone: input.timezone,
          currency: input.currency,
          defaultLocale: input.defaultLocale,
          enabledLocales: input.enabledLocales,
          country: input.country ?? null,
          address: input.address,
          geoLat: input.geo ? String(input.geo.lat) : null,
          geoLng: input.geo ? String(input.geo.lng) : null,
          settings: input.settings,
        });
        // Root of the location tree (Spec §4.4): the property itself.
        const root = await this.repo.insertLocation({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: row.id,
          parentId: null,
          kind: 'PROPERTY',
          code,
          path: ltreeLabel(code),
          sortOrder: 0,
          metadata: {},
        });
        await this.repo.upsertLocationTranslations(
          root.id,
          input.enabledLocales.map((locale) => ({ locale, name: input.name })),
        );
        await this.events.publish(PropertyCreated, {
          tenantId: scope.tenantId,
          propertyId: row.id,
          source: 'org',
          aggregate: { type: 'property', id: row.id },
          payload: {
            property_id: row.id,
            tenant_id: scope.tenantId,
            organization_id: row.organizationId,
            code: row.code,
            name: row.name,
            timezone: row.timezone,
            currency: row.currency,
            default_locale: row.defaultLocale,
          },
        });
        await this.audit.record({
          action: 'org.property.create',
          entityType: 'property',
          entityId: row.id,
          tenantId: scope.tenantId,
          propertyId: row.id,
          after: row,
        });
        return row;
      }),
    );
  }

  async get(scope: TenantScope, id: string): Promise<PropertyRow> {
    const row = await this.repo.propertyById(scope, id);
    if (!row) throw AppError.notFound('org.property.not_found');
    return row;
  }
  list(scope: TenantScope): Promise<PropertyRow[]> {
    return this.repo.listProperties(scope);
  }

  update(scope: TenantScope, id: string, input: UpdatePropertyInput): Promise<PropertyRow> {
    return this.gate.execute(
      { action: 'org.property.manage', tenantId: scope.tenantId, propertyId: id },
      () =>
        this.tx.run(async () => {
          const current = await this.get(scope, id);
          const { version, ...patch } = input;
          const next = {
            ...current,
            ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          } as PropertyRow;
          if (!next.enabledLocales.includes(next.defaultLocale))
            throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
          const updated = await this.repo.updateProperty(
            scope,
            id,
            version,
            Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          );
          if (!updated) throw AppError.conflict('platform.conflict');
          const changed = Object.keys(patch).filter(
            (k) => (patch as Record<string, unknown>)[k] !== undefined,
          );
          await this.events.publish(PropertyUpdated, {
            tenantId: scope.tenantId,
            propertyId: id,
            source: 'org',
            aggregate: { type: 'property', id },
            payload: { property_id: id, changed },
          });
          await this.audit.record({
            action: 'org.property.update',
            entityType: 'property',
            entityId: id,
            tenantId: scope.tenantId,
            propertyId: id,
            before: current,
            after: updated,
          });
          return updated;
        }),
    );
  }
}

@Injectable()
export class LocationService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly locale: CurrentLocale,
  ) {}

  create(scope: PropertyScope, input: CreateLocationInput): Promise<LocationRow> {
    return this.gate.execute(
      { action: 'org.location.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const parent = await this.resolveParent(scope, input.parentId ?? null);
          const code = input.code.trim();
          if (await this.repo.locationByParentAndCode(scope, parent.id, code))
            throw AppError.conflict('org.location.code_taken', { code });
          const row = await this.repo.insertLocation({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            parentId: parent.id,
            kind: input.kind,
            code,
            path: `${parent.path}.${ltreeLabel(code)}`,
            sortOrder: input.sortOrder,
            metadata: input.metadata,
          });
          await this.repo.upsertLocationTranslations(row.id, input.translations);
          await this.events.publish(LocationCreated, {
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            source: 'org',
            aggregate: { type: 'location', id: row.id },
            payload: {
              location_id: row.id,
              property_id: scope.propertyId,
              parent_id: parent.id,
              kind: row.kind,
              code: row.code,
              path: row.path,
            },
          });
          await this.audit.record({
            action: 'org.location.create',
            entityType: 'location',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { ...row, translations: input.translations },
          });
          return row;
        }),
    );
  }

  /** The property root when parentId is null; otherwise a container location of this property. */
  async resolveParent(scope: PropertyScope, parentId: string | null): Promise<LocationRow> {
    if (!parentId) {
      const roots = (await this.repo.listLocations(scope)).filter((l) => l.parentId === null);
      if (roots.length === 0) throw AppError.notFound('org.location.not_found');
      return roots[0]!;
    }
    const parent = await this.repo.locationById(scope, parentId);
    if (!parent) throw AppError.notFound('org.location.not_found');
    if (!CONTAINER_KINDS.has(parent.kind))
      throw new AppError('org.location.invalid_parent', HttpStatus.UNPROCESSABLE_ENTITY);
    return parent;
  }

  /** Localized tree: requested locale → property default → en → code. */
  async tree(
    scope: PropertyScope,
    property: PropertyRow,
    locale = this.locale.get(),
  ): Promise<LocationNode[]> {
    const [rows, roomRows, roomTypes] = await Promise.all([
      this.repo.listLocations(scope),
      this.repo.listRooms(scope),
      this.repo.listRoomTypes(scope),
    ]);
    const translations = await this.repo.locationTranslationsFor(rows.map((r) => r.id));
    const typeTranslations = await this.repo.roomTypeTranslationsFor(roomTypes.map((t) => t.id));
    const pick = (
      entityId: string,
      list: Array<{ entityId: string; locale: string; name: string }>,
      fallback: string,
    ): string => {
      const mine = list.filter((t) => t.entityId === entityId);
      return (
        mine.find((t) => t.locale === locale)?.name ??
        mine.find((t) => t.locale === property.defaultLocale)?.name ??
        mine.find((t) => t.locale === 'en')?.name ??
        fallback
      );
    };
    const roomsByLocation = new Map(roomRows.map((r) => [r.locationId, r]));
    const nodes = new Map<string, LocationNode>();
    for (const r of rows) {
      const room = roomsByLocation.get(r.id);
      nodes.set(r.id, {
        id: r.id,
        parentId: r.parentId,
        kind: r.kind,
        code: r.code,
        path: r.path,
        sortOrder: r.sortOrder,
        status: r.status,
        name: pick(r.id, translations, room?.roomNumber ?? r.code),
        room: room
          ? {
              roomNumber: room.roomNumber,
              roomTypeId: room.roomTypeId,
              roomTypeName: room.roomTypeId
                ? pick(room.roomTypeId, typeTranslations, '') || null
                : null,
              bedConfig: room.bedConfig,
            }
          : null,
        children: [],
      });
    }
    const roots: LocationNode[] = [];
    for (const n of nodes.values()) {
      if (n.parentId && nodes.has(n.parentId)) nodes.get(n.parentId)!.children.push(n);
      else roots.push(n);
    }
    const sortRec = (list: LocationNode[]): void => {
      list.sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.code.localeCompare(b.code, undefined, { numeric: true }),
      );
      list.forEach((c) => sortRec(c.children));
    };
    sortRec(roots);
    return roots;
  }
}

@Injectable()
export class RoomService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly locations: LocationService,
  ) {}

  createRoomType(scope: PropertyScope, input: CreateRoomTypeInput): Promise<RoomTypeRow> {
    return this.gate.execute(
      { action: 'org.location.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const code = normalizeCode(input.code);
          if (await this.repo.roomTypeByCode(scope, code))
            throw AppError.conflict('org.location.code_taken', { code });
          const row = await this.repo.insertRoomType({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            code,
            capacity: input.capacity,
            attributes: input.attributes,
          });
          await this.repo.upsertRoomTypeTranslations(row.id, input.translations);
          await this.audit.record({
            action: 'org.room_type.create',
            entityType: 'room_type',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { ...row, translations: input.translations },
          });
          return row;
        }),
    );
  }
  listRoomTypes(scope: PropertyScope): Promise<RoomTypeRow[]> {
    return this.repo.listRoomTypes(scope);
  }

  /** A room = a ROOM location under a container + its specialization row, in one transaction. */
  create(scope: PropertyScope, property: PropertyRow, input: CreateRoomInput): Promise<RoomRow> {
    return this.gate.execute(
      { action: 'org.location.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const roomNumber = input.roomNumber.trim();
          if (await this.repo.roomByNumber(scope, roomNumber))
            throw AppError.conflict('org.room.number_taken', { roomNumber });
          const parent = await this.locations.resolveParent(scope, input.parentId);
          if (input.roomTypeId && !(await this.repo.roomTypeById(scope, input.roomTypeId)))
            throw AppError.notFound('org.room_type.not_found');
          if (await this.repo.locationByParentAndCode(scope, parent.id, roomNumber))
            throw AppError.conflict('org.location.code_taken', { code: roomNumber });
          const location = await this.repo.insertLocation({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            parentId: parent.id,
            kind: 'ROOM',
            code: roomNumber,
            path: `${parent.path}.${ltreeLabel(roomNumber)}`,
            sortOrder: 0,
            metadata: {},
          });
          const translations =
            input.translations.length > 0
              ? input.translations
              : property.enabledLocales.map((locale) => ({ locale, name: roomNumber }));
          await this.repo.upsertLocationTranslations(location.id, translations);
          const room = await this.repo.insertRoom({
            locationId: location.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            roomNumber,
            roomTypeId: input.roomTypeId ?? null,
            bedConfig: input.bedConfig ?? null,
            floorLabel: input.floorLabel ?? null,
            connectingRoomId: input.connectingRoomId ?? null,
            attributes: input.attributes,
          });
          await this.events.publish(RoomCreated, {
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            source: 'org',
            aggregate: { type: 'room', id: room.locationId },
            payload: {
              room_id: room.locationId,
              property_id: scope.propertyId,
              room_number: roomNumber,
              room_type_id: room.roomTypeId,
            },
          });
          await this.audit.record({
            action: 'org.room.create',
            entityType: 'room',
            entityId: room.locationId,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: room,
          });
          return room;
        }),
    );
  }
  list(scope: PropertyScope): Promise<RoomRow[]> {
    return this.repo.listRooms(scope);
  }
}

@Injectable()
export class BrandingService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly attribution: AttributionPolicyService,
    private readonly actors: ActorStore,
  ) {}

  upsert(scope: TenantScope, input: UpsertBrandProfileInput): Promise<BrandProfileRow> {
    const propertyId =
      input.scope === 'PROPERTY' || input.scope === 'CHANNEL' ? input.scopeId : null;
    return this.gate.execute(
      { action: 'branding.manage', tenantId: scope.tenantId, propertyId },
      () =>
        this.tx.run(async () => {
          // The target must belong to this tenant (never let one tenant brand another's property).
          if (input.scope === 'TENANT' && input.scopeId !== scope.tenantId)
            throw new AppError('org.brand_profile.invalid_scope', HttpStatus.UNPROCESSABLE_ENTITY);
          if (
            input.scope === 'ORGANIZATION' &&
            !(await this.repo.organizationById(scope, input.scopeId))
          )
            throw AppError.notFound('org.organization.not_found');
          if (
            (input.scope === 'PROPERTY' || input.scope === 'CHANNEL') &&
            !(await this.repo.propertyById(scope, input.scopeId))
          )
            throw AppError.notFound('org.property.not_found');
          if (input.scope === 'CHANNEL' && !input.channel)
            throw new AppError('org.brand_profile.invalid_scope', HttpStatus.UNPROCESSABLE_ENTITY);
          const channel = input.scope === 'CHANNEL' ? (input.channel ?? null) : null;
          const row = await this.repo.upsertBrandProfile({
            id: newId(),
            tenantId: scope.tenantId,
            scope: input.scope,
            scopeId: input.scopeId,
            channel,
            displayName: input.displayName ?? null,
            logoAssetKey: input.logoAssetKey ?? null,
            logoAltAssetKey: input.logoAltAssetKey ?? null,
            primaryColor: input.primaryColor ?? null,
            secondaryColor: input.secondaryColor ?? null,
            coverAssetKeys: input.coverAssetKeys,
            faviconAssetKey: input.faviconAssetKey ?? null,
            typography: input.typography,
            contact: input.contact,
            social: input.social,
            aiPersona: input.aiPersona,
            presentation: input.presentation,
          });
          await this.repo.upsertBrandTranslations(row.id, input.translations);
          await this.events.publish(BrandProfileUpdated, {
            tenantId: scope.tenantId,
            propertyId,
            source: 'org',
            aggregate: { type: 'brand_profile', id: row.id },
            payload: {
              brand_profile_id: row.id,
              tenant_id: scope.tenantId,
              scope: row.scope,
              scope_id: row.scopeId,
              channel: row.channel,
            },
          });
          await this.audit.record({
            action: 'org.brand_profile.upsert',
            entityType: 'brand_profile',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId,
            after: { ...row, translations: input.translations },
          });
          return row;
        }),
    );
  }

  list(scope: TenantScope): Promise<BrandProfileRow[]> {
    return this.repo.brandProfilesForTenant(scope);
  }

  /** Guest-facing resolution (public): platform → tenant → organization → property → channel, plus attribution. */
  async resolve(
    propertyId: string,
    channel: string | null,
    locale: string | null,
  ): Promise<ResolvedBrand> {
    const property = await this.repo.propertyByIdUnscoped(propertyId);
    if (!property || property.status === 'INACTIVE')
      throw AppError.notFound('org.property.not_found');
    const scope = { tenantId: property.tenantId };
    const effectiveLocale =
      locale && property.enabledLocales.includes(locale) ? locale : property.defaultLocale;
    const rows = await this.repo.brandLayersForProperty(
      scope,
      property.organizationId,
      propertyId,
      channel,
    );
    const translations = await this.repo.brandTranslations(rows.map((r) => r.id));
    const toLayer = (row: BrandProfileRow | undefined): BrandLayer | null => {
      if (!row) return null;
      const t = translations.filter((x) => x.entityId === row.id);
      const tr =
        t.find((x) => x.locale === effectiveLocale) ??
        t.find((x) => x.locale === property.defaultLocale) ??
        null;
      return {
        displayName: row.displayName,
        logoAssetKey: row.logoAssetKey,
        logoAltAssetKey: row.logoAltAssetKey,
        primaryColor: row.primaryColor,
        secondaryColor: row.secondaryColor,
        coverAssetKeys: row.coverAssetKeys,
        faviconAssetKey: row.faviconAssetKey,
        typography: row.typography as Record<string, unknown>,
        contact: row.contact as Record<string, unknown>,
        social: row.social as Record<string, unknown>,
        aiPersona: row.aiPersona as Record<string, unknown>,
        presentation: row.presentation as Record<string, unknown>,
        welcomeText: tr?.welcomeText ?? null,
        farewellText: tr?.farewellText ?? null,
      };
    };
    const find = (
      s: BrandProfileRow['scope'],
      id: string,
      ch: string | null,
    ): BrandProfileRow | undefined =>
      rows.find((r) => r.scope === s && r.scopeId === id && r.channel === ch);
    return mergeBrand(
      propertyId,
      channel,
      effectiveLocale,
      property.name,
      [
        { name: 'tenant', layer: toLayer(find('TENANT', property.tenantId, null)) },
        {
          name: 'organization',
          layer: property.organizationId
            ? toLayer(find('ORGANIZATION', property.organizationId, null))
            : null,
        },
        { name: 'property', layer: toLayer(find('PROPERTY', propertyId, null)) },
        { name: 'channel', layer: channel ? toLayer(find('CHANNEL', propertyId, channel)) : null },
      ],
      await this.attribution.resolve(property.tenantId),
    );
  }

  actor(): RequestActor {
    return this.actors.require();
  }
}
