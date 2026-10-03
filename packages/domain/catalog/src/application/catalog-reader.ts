import { Inject, Injectable } from '@nestjs/common';
import { GUEST_API, type GuestPrincipal, type GuestPublicApi } from '@hotella/domain-guest/public';
import {
  ORGANIZATION_API,
  type OrganizationPublicApi,
  type PropertySummary,
} from '@hotella/domain-organization/public';
import type { PropertyScope } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import {
  type Availability,
  availabilitySchema,
  type Eligibility,
  eligibilityProblem,
  eligibilitySchema,
  type FieldDefinition,
  isOpenAt,
  pickTranslation,
  type Price,
} from '../domain/rules';
import { CatalogRepositories } from '../infrastructure/repositories';
import type {
  CategoryRow,
  DefinitionRow,
  VersionRow,
  VersionTranslationRow,
} from '../infrastructure/schema';

/** A published, active service as one property sees it (property definitions replace tenant-wide ones). */
export interface EffectiveService {
  readonly definition: DefinitionRow;
  readonly version: VersionRow;
  readonly category: CategoryRow;
  readonly eligibility: Eligibility;
  readonly availability: Availability;
  readonly fields: readonly FieldDefinition[];
}

/** Who is asking, for eligibility (Spec §7 "eligibility"). */
export interface GuestStanding {
  readonly stayId: string;
  readonly stayStatus: string;
  readonly partyRole: 'PRIMARY' | 'ACCOMPANYING';
  readonly roomId: string | null;
  readonly roomNumber: string | null;
  readonly roomTypeId: string | null;
}

/**
 * Reads the catalog as a property serves it: what is published, active and visible, with eligibility evaluated and
 * names localized through the fallback chain (BUILD_PLAN §9.2). Callers run it inside a read transaction.
 */
@Injectable()
export class CatalogReader {
  constructor(
    private readonly repo: CatalogRepositories,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  async property(scope: PropertyScope): Promise<PropertySummary> {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    if (!property) throw AppError.notFound('org.property.not_found');
    return property;
  }

  /** Every published, active service of the property (guest-visible or not). */
  async effectiveServices(scope: PropertyScope): Promise<EffectiveService[]> {
    const allCategories = await this.repo.categoriesAt(scope, scope.propertyId);
    const byCode = new Map(preferProperty(allCategories).map((c) => [c.code, c]));
    // A property row replaces the chain's once it is published (or retired: the property opts out); an unpublished
    // property draft leaves the chain's service in place.
    const definitions = preferProperty(
      (await this.repo.definitionsAt(scope, scope.propertyId)).filter(
        (d) => d.status === 'RETIRED' || d.publishedVersionId,
      ),
    ).filter((d) => d.status === 'ACTIVE');
    const published = await this.repo.publishedVersionsAt(
      scope,
      definitions.map((d) => d.id),
    );
    const out: EffectiveService[] = [];
    for (const { definition, version } of published) {
      const own = allCategories.find((c) => c.id === definition.categoryId);
      const category = own ? byCode.get(own.code) : undefined;
      if (!category || category.status !== 'ACTIVE') continue;
      out.push({
        definition,
        version,
        category,
        eligibility: eligibilitySchema.parse(version.eligibility),
        availability: availabilitySchema.parse(version.availability),
        fields: version.requiredFields as FieldDefinition[],
      });
    }
    return out.sort(
      (a, b) =>
        a.category.sortOrder - b.category.sortOrder ||
        a.definition.sortOrder - b.definition.sortOrder ||
        a.definition.code.localeCompare(b.definition.code),
    );
  }

  async service(scope: PropertyScope, code: string): Promise<EffectiveService | undefined> {
    return (await this.effectiveServices(scope)).find((s) => s.definition.code === code);
  }

  /** The guest's stay, party role and room, from the guest and organization contexts. */
  async standing(p: GuestPrincipal): Promise<GuestStanding> {
    if (!p.stayId) throw AppError.forbidden('catalog.request.stay_required');
    return this.standingOf(p.tenantId, p.propertyId, p.stayId, p.guestId);
  }

  async standingOf(
    tenantId: string,
    propertyId: string,
    stayId: string,
    guestId: string,
  ): Promise<GuestStanding> {
    const stay = await this.guests.getStay(tenantId, stayId);
    if (!stay || stay.propertyId !== propertyId) throw AppError.notFound('guest.stay.not_found');
    if (!stay.partyGuestIds.includes(guestId)) throw AppError.notFound('guest.guest.not_found');
    const room = stay.currentRoomId
      ? await this.org.getRoom(tenantId, propertyId, stay.currentRoomId)
      : null;
    return {
      stayId,
      stayStatus: stay.status,
      partyRole: stay.primaryGuestId === guestId ? 'PRIMARY' : 'ACCOMPANYING',
      roomId: stay.currentRoomId,
      roomNumber: room?.roomNumber ?? null,
      roomTypeId: room?.roomTypeId ?? null,
    };
  }

  /** The guest catalog: eligible, guest-visible, translated services grouped by category. */
  async guestCatalog(p: GuestPrincipal, locale: string, now = new Date()) {
    const scope = { tenantId: p.tenantId, propertyId: p.propertyId };
    const property = await this.property(scope);
    const standing = await this.standing(p);
    const services = (await this.effectiveServices(scope)).filter(
      (s) => s.version.guestVisible && eligibilityProblem(s.eligibility, standing) === null,
    );
    const versionTranslations = await this.repo.versionTranslations(
      services.map((s) => s.version.id),
    );
    const categoryTranslations = await this.repo.categoryTranslations([
      ...new Set(services.map((s) => s.category.id)),
    ]);
    const groups = new Map<string, { category: CategoryRow; services: GuestServiceView[] }>();
    for (const s of services) {
      const view = guestServiceView(s, versionTranslations, locale, property, now);
      if (!view) continue;
      const group = groups.get(s.category.id) ?? { category: s.category, services: [] };
      group.services.push(view);
      groups.set(s.category.id, group);
    }
    return {
      categories: [...groups.values()].flatMap(({ category, services: list }) => {
        const t = pickTranslation(
          categoryTranslations.filter((x) => x.entityId === category.id),
          locale,
          property.defaultLocale,
        );
        return t
          ? [
              {
                code: category.code,
                icon: category.icon,
                name: t.name,
                description: t.description,
                locale: t.locale,
                services: list,
              },
            ]
          : [];
      }),
    };
  }

  async guestService(p: GuestPrincipal, code: string, locale: string, now = new Date()) {
    const scope = { tenantId: p.tenantId, propertyId: p.propertyId };
    const property = await this.property(scope);
    const standing = await this.standing(p);
    const s = await this.service(scope, code);
    if (!s || !s.version.guestVisible || eligibilityProblem(s.eligibility, standing) !== null)
      throw AppError.notFound('catalog.service.not_found');
    const view = guestServiceView(
      s,
      await this.repo.versionTranslations([s.version.id]),
      locale,
      property,
      now,
    );
    if (!view) throw AppError.notFound('catalog.service.not_found');
    return view;
  }

  /** The service's name for `locale` (fallback chain); the code when nothing is translated. */
  async serviceName(
    scope: PropertyScope,
    versionId: string,
    locale: string,
    property?: PropertySummary,
  ): Promise<string> {
    const p = property ?? (await this.property(scope));
    const rows = await this.repo.versionTranslations([versionId]);
    const version = await this.repo.version(scope, versionId);
    const def = version ? await this.repo.definition(scope, version.definitionId) : undefined;
    return pickTranslation(rows, locale, p.defaultLocale)?.name ?? def?.code ?? '';
  }
}

export interface GuestServiceView {
  readonly code: string;
  readonly versionId: string;
  readonly locale: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly description: string | null;
  readonly price: Price;
  readonly fields: ReadonlyArray<{
    readonly code: string;
    readonly type: FieldDefinition['type'];
    readonly required: boolean;
    readonly label: string;
    readonly min?: number;
    readonly max?: number;
    readonly maxLength?: number;
    readonly options?: ReadonlyArray<{ readonly code: string; readonly label: string }>;
  }>;
  readonly openNow: boolean;
  readonly allowScheduling: boolean;
  readonly leadTimeMinutes: number;
}

function guestServiceView(
  s: EffectiveService,
  translations: readonly VersionTranslationRow[],
  locale: string,
  property: PropertySummary,
  now: Date,
): GuestServiceView | null {
  const t = pickTranslation(
    translations.filter((x) => x.entityId === s.version.id),
    locale,
    property.defaultLocale,
  );
  if (!t) return null;
  const labels = (t.fieldLabels ?? {}) as Record<
    string,
    { label?: string; options?: Record<string, string> }
  >;
  return {
    code: s.definition.code,
    versionId: s.version.id,
    locale: t.locale,
    name: t.name,
    shortDescription: t.shortDescription,
    description: t.description,
    price: (s.version.price ?? null) as Price,
    fields: s.fields.map((f) => {
      const l = labels[f.code];
      const label = l?.label ?? f.code;
      switch (f.type) {
        case 'TEXT':
          return {
            code: f.code,
            type: f.type,
            required: f.required,
            label,
            maxLength: f.maxLength,
          };
        case 'NUMBER':
          return {
            code: f.code,
            type: f.type,
            required: f.required,
            label,
            min: f.min,
            max: f.max,
          };
        case 'CHOICE':
          return {
            code: f.code,
            type: f.type,
            required: f.required,
            label,
            options: f.options.map((o) => ({ code: o, label: l?.options?.[o] ?? o })),
          };
        default:
          return { code: f.code, type: f.type, required: f.required, label };
      }
    }),
    openNow: isOpenAt(s.availability, now, property.timezone),
    allowScheduling: s.availability.allowScheduling,
    leadTimeMinutes: s.availability.leadTimeMinutes,
  };
}

/** Property rows replace tenant-wide rows with the same code. */
function preferProperty<T extends { readonly code: string; readonly propertyId: string | null }>(
  rows: readonly T[],
): T[] {
  const byCode = new Map<string, T>();
  for (const r of rows) {
    const seen = byCode.get(r.code);
    if (!seen || (seen.propertyId === null && r.propertyId !== null)) byCode.set(r.code, r);
  }
  return rows.filter((r) => byCode.get(r.code) === r);
}
