import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ActionGate } from '@hotella/platform-auth';
import { newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { StorageService } from '@hotella/platform-storage';
import {
  BRAND_IMAGE_EXTENSIONS,
  BRAND_IMAGE_MAX_BYTES,
  brandAssetPrefix,
  type BrandImageType,
  type ResolvedBrand,
  sniffBrandImage,
} from '../domain/branding';
import { OrganizationRepositories } from '../infrastructure/repositories';
import type { BrandProfileRow } from '../infrastructure/schema';
import type { UpdatePropertyBrandInput, UpsertBrandProfileInput } from './dto';
import { BrandingService } from './services';

export interface PropertyBrand {
  /** The property's own layer (what a hotel manager edits); null until something is set. */
  readonly profile: {
    readonly displayName: string | null;
    readonly primaryColor: string | null;
    readonly logoAssetKey: string | null;
  } | null;
  /** What guests and staff actually see after inheritance (tenant → organization → property). */
  readonly resolved: ResolvedBrand;
}

/**
 * The hotel's own brand from the property's point of view (Spec Product Identity): name, colour and logo, editable by
 * a property manager without touching the tenant-wide profiles. Images go to object storage under the tenant's
 * prefix (Spec §2.4: binaries never in PostgreSQL), their type is read from the bytes and SVG is refused.
 */
@Injectable()
export class BrandAssetService {
  constructor(
    private readonly repo: OrganizationRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly branding: BrandingService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  get(scope: PropertyScope, locale: string | null): Promise<PropertyBrand> {
    return this.gate.execute(
      { action: 'branding.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const row = await this.tx.read(() => this.own(scope));
        return {
          profile: row
            ? {
                displayName: row.displayName,
                primaryColor: row.primaryColor,
                logoAssetKey: row.logoAssetKey,
              }
            : null,
          resolved: await this.branding.resolve(scope.propertyId, null, locale),
        };
      },
    );
  }

  /** Name and colour; `null` clears a field so the tenant's value shows through again. */
  async update(scope: PropertyScope, input: UpdatePropertyBrandInput, locale: string | null) {
    await this.save(scope, {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.primaryColor !== undefined ? { primaryColor: input.primaryColor } : {}),
    });
    return this.get(scope, locale);
  }

  async setLogo(scope: PropertyScope, bytes: Buffer, locale: string | null) {
    const type = sniffBrandImage(bytes);
    if (!type) throw new AppError('org.brand_asset.unsupported', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    if (bytes.length > BRAND_IMAGE_MAX_BYTES)
      throw new AppError('org.brand_asset.too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    const storage = this.requireStorage();
    // Authorize before anything is written; the profile change below is authorized and audited again by upsert.
    const key = await this.gate.execute(
      { action: 'branding.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const k = `${brandAssetPrefix(scope.tenantId)}${newId()}.${BRAND_IMAGE_EXTENSIONS[type]}`;
        await storage.put({ key: k, body: bytes, contentType: type });
        return k;
      },
    );
    await this.save(scope, { logoAssetKey: key });
    return this.get(scope, locale);
  }

  async clearLogo(scope: PropertyScope, locale: string | null) {
    await this.save(scope, { logoAssetKey: null });
    return this.get(scope, locale);
  }

  /** Public: the logo the property's resolved brand points at (so only images a brand uses are ever served). */
  async logo(
    propertyId: string,
    channel: string | null,
  ): Promise<{ body: Buffer; type: BrandImageType }> {
    const brand = await this.branding.resolve(propertyId, channel, null);
    if (!brand.logoAssetKey || !this.storage) throw AppError.notFound('org.brand_asset.not_found');
    const body = await this.storage.getBuffer(brand.logoAssetKey).catch(() => null);
    const type = body ? sniffBrandImage(body) : null;
    if (!body || !type) throw AppError.notFound('org.brand_asset.not_found');
    return { body, type };
  }

  private own(scope: PropertyScope): Promise<BrandProfileRow | undefined> {
    return this.repo.brandProfile(scope, 'PROPERTY', scope.propertyId, null);
  }

  /** Rewrites the property layer with the changed fields, keeping everything else exactly as it was. */
  private async save(
    scope: PropertyScope,
    changes: Partial<
      Pick<UpsertBrandProfileInput, 'displayName' | 'primaryColor' | 'logoAssetKey'>
    >,
  ): Promise<void> {
    const row = await this.tx.read(() => this.own(scope));
    await this.branding.upsert(scope, {
      scope: 'PROPERTY',
      scopeId: scope.propertyId,
      channel: null,
      displayName: row?.displayName ?? null,
      logoAssetKey: row?.logoAssetKey ?? null,
      logoAltAssetKey: row?.logoAltAssetKey ?? null,
      primaryColor: row?.primaryColor ?? null,
      secondaryColor: row?.secondaryColor ?? null,
      coverAssetKeys: row?.coverAssetKeys ?? [],
      faviconAssetKey: row?.faviconAssetKey ?? null,
      typography: (row?.typography ?? {}) as UpsertBrandProfileInput['typography'],
      contact: (row?.contact ?? {}) as UpsertBrandProfileInput['contact'],
      social: (row?.social ?? {}) as UpsertBrandProfileInput['social'],
      aiPersona: (row?.aiPersona ?? {}) as UpsertBrandProfileInput['aiPersona'],
      presentation: (row?.presentation ?? {}) as UpsertBrandProfileInput['presentation'],
      translations: [],
      ...changes,
    });
  }

  private requireStorage(): StorageService {
    if (!this.storage) throw new AppError('platform.not_ready', HttpStatus.SERVICE_UNAVAILABLE);
    return this.storage;
  }
}
