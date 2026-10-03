import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KNOWLEDGE_API, type KnowledgePublicApi } from '@hotella/domain-knowledge/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { checkProperties, compatibleChange, propertiesSchema } from '../domain/properties';
import { FAILURE_KINDS, STARTER_FAILURE_CODES } from '../domain/taxonomy';
import { EngineeringRepositories, type Translation } from '../infrastructure/repositories';
import type { AssetRow, AssetTypeRow, FailureCodeRow } from '../infrastructure/schema';

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const isoDay = z.iso.date();
const translations = z
  .array(z.object({ locale: z.string().min(2).max(16), name: z.string().trim().min(1).max(120) }))
  .min(1)
  .max(10);
const propertyValues = z.record(
  z.string(),
  z.union([z.string().max(500), z.number(), z.boolean()]),
);

export const createAssetTypeSchema = z.object({
  code: z.string().regex(CODE),
  translations,
  properties: propertiesSchema.default([]),
});
export const updateAssetTypeSchema = z.object({
  version: z.number().int().min(1),
  translations: translations.optional(),
  properties: propertiesSchema.optional(),
  active: z.boolean().optional(),
});
export const createAssetModelSchema = z.object({
  assetTypeId: z.uuid(),
  manufacturer: z.string().trim().min(1).max(120),
  modelCode: z.string().trim().min(1).max(120),
  expectedLifeMonths: z.number().int().min(1).max(1200).optional(),
});
export const createAssetSchema = z.object({
  assetNumber: z.string().trim().min(1).max(40),
  assetTypeId: z.uuid(),
  assetModelId: z.uuid().optional(),
  locationId: z.uuid(),
  parentAssetId: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  serialNumber: z.string().trim().max(120).optional(),
  criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  installedAt: isoDay.optional(),
  warrantyUntil: isoDay.optional(),
  properties: propertyValues.default({}),
});
export const updateAssetSchema = z.object({
  version: z.number().int().min(1),
  assetModelId: z.uuid().nullable().optional(),
  locationId: z.uuid().optional(),
  parentAssetId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  serialNumber: z.string().trim().max(120).nullable().optional(),
  status: z.enum(['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED']).optional(),
  criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  installedAt: isoDay.nullable().optional(),
  warrantyUntil: isoDay.nullable().optional(),
  properties: propertyValues.optional(),
});
export const listAssetsSchema = z.object({
  locationId: z.uuid().optional(),
  assetTypeId: z.uuid().optional(),
});
export const linkDocumentSchema = z
  .object({
    knowledgeDocumentId: z.uuid(),
    kind: z.enum(['MANUAL', 'DATASHEET', 'WARRANTY', 'DIAGRAM', 'PHOTO']),
    assetId: z.uuid().optional(),
    assetModelId: z.uuid().optional(),
  })
  .refine((v) => Boolean(v.assetId) !== Boolean(v.assetModelId), {
    message: 'exactly one of assetId and assetModelId',
  });
export const createFailureCodeSchema = z.object({
  kind: z.enum(FAILURE_KINDS),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,59}$/),
  translations,
  assetTypeId: z.uuid().optional(),
});
export const listFailureCodesSchema = z.object({ kind: z.enum(FAILURE_KINDS).optional() });

/**
 * The asset registry and failure taxonomy (Spec §10.1–§10.5, BUILD_PLAN 8.1). Types and models are tenant-wide;
 * assets belong to a property and sit at one of its locations. Every change goes through the action gate and is
 * audited; documents stay in the knowledge layer and are only linked.
 */
@Injectable()
export class AssetService {
  constructor(
    private readonly repo: EngineeringRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(KNOWLEDGE_API) private readonly knowledge: KnowledgePublicApi,
  ) {}

  // ---- asset types (tenant) ----

  createAssetType(scope: TenantScope, input: z.infer<typeof createAssetTypeSchema>) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const row = await this.repo.insertAssetType({
          id: newId(),
          tenantId: scope.tenantId,
          code: input.code,
          properties: input.properties,
        });
        if (!row) throw AppError.conflict('eng.asset_type.code_taken');
        await this.repo.putAssetTypeTranslations(row.id, input.translations);
        await this.audit.record({
          action: 'eng.asset_type.create',
          entityType: 'asset_type',
          entityId: row.id,
          tenantId: scope.tenantId,
          after: { code: row.code, fields: row.properties.map((f) => f.key) },
        });
        return this.typeView(row, input.translations);
      }),
    );
  }

  /** Changes keep existing assets valid (no new required field, nothing removed or retyped). */
  updateAssetType(scope: TenantScope, id: string, input: z.infer<typeof updateAssetTypeSchema>) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const current = isUuid(id) ? await this.repo.assetTypeForUpdate(scope, id) : undefined;
        if (!current) throw AppError.notFound('eng.asset_type.not_found');
        if (current.version !== input.version)
          throw AppError.conflict('eng.asset_type.version_conflict');
        if (input.properties && !compatibleChange(current.properties, input.properties))
          throw AppError.conflict('eng.asset_type.incompatible_change');
        const row = await this.repo.updateAssetType(scope, id, {
          ...(input.properties ? { properties: input.properties } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
        });
        if (input.translations) await this.repo.putAssetTypeTranslations(id, input.translations);
        await this.audit.record({
          action: 'eng.asset_type.update',
          entityType: 'asset_type',
          entityId: id,
          tenantId: scope.tenantId,
          before: { fields: current.properties.map((f) => f.key), active: current.active },
          after: { fields: row.properties.map((f) => f.key), active: row.active },
        });
        return this.typeView(row, (await this.repo.assetTypeTranslations([id])).get(id) ?? []);
      }),
    );
  }

  listAssetTypes(scope: TenantScope) {
    return this.gate.execute({ action: 'eng.asset.read', tenantId: scope.tenantId }, () =>
      this.tx.read(async () => {
        const rows = await this.repo.assetTypes(scope);
        const names = await this.repo.assetTypeTranslations(rows.map((r) => r.id));
        return rows.map((r) => this.typeView(r, names.get(r.id) ?? []));
      }),
    );
  }

  // ---- models (tenant) ----

  createAssetModel(scope: TenantScope, input: z.infer<typeof createAssetModelSchema>) {
    return this.gate.execute({ action: 'eng.asset.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        if (!(await this.repo.assetType(scope, input.assetTypeId)))
          throw AppError.notFound('eng.asset_type.not_found');
        const row = await this.repo.insertAssetModel({
          id: newId(),
          tenantId: scope.tenantId,
          assetTypeId: input.assetTypeId,
          manufacturer: input.manufacturer,
          modelCode: input.modelCode,
          expectedLifeMonths: input.expectedLifeMonths ?? null,
        });
        if (!row) throw AppError.conflict('eng.asset_model.taken');
        await this.audit.record({
          action: 'eng.asset_model.create',
          entityType: 'asset_model',
          entityId: row.id,
          tenantId: scope.tenantId,
          after: { manufacturer: row.manufacturer, model_code: row.modelCode },
        });
        return row;
      }),
    );
  }

  listAssetModels(scope: TenantScope, assetTypeId?: string) {
    return this.gate.execute({ action: 'eng.asset.read', tenantId: scope.tenantId }, () =>
      this.tx.read(() => this.repo.assetModels(scope, assetTypeId)),
    );
  }

  // ---- assets (property) ----

  createAsset(scope: PropertyScope, input: z.infer<typeof createAssetSchema>) {
    return this.gate.execute(
      { action: 'eng.asset.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const type = await this.repo.assetType(scope, input.assetTypeId);
          if (!type || !type.active) throw AppError.notFound('eng.asset_type.not_found');
          await this.checkPlacement(scope, type, input);
          this.checkValues(type, input.properties);
          const row = await this.repo.insertAsset({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            parentAssetId: input.parentAssetId ?? null,
            assetNumber: input.assetNumber,
            assetTypeId: type.id,
            assetModelId: input.assetModelId ?? null,
            locationId: input.locationId,
            name: input.name,
            serialNumber: input.serialNumber ?? null,
            criticality: input.criticality,
            installedAt: input.installedAt ?? null,
            warrantyUntil: input.warrantyUntil ?? null,
            properties: input.properties,
          });
          if (!row) throw AppError.conflict('eng.asset.number_taken');
          await this.audit.record({
            action: 'eng.asset.create',
            entityType: 'asset',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { asset_number: row.assetNumber, type: type.code, location_id: row.locationId },
          });
          return row;
        }),
    );
  }

  updateAsset(scope: PropertyScope, id: string, input: z.infer<typeof updateAssetSchema>) {
    return this.gate.execute(
      { action: 'eng.asset.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const current = await this.findForUpdate(scope, id);
          if (current.version !== input.version)
            throw AppError.conflict('eng.asset.version_conflict');
          const type = (await this.repo.assetType(scope, current.assetTypeId))!;
          const next = {
            locationId: input.locationId ?? current.locationId,
            assetModelId:
              input.assetModelId === undefined ? current.assetModelId : input.assetModelId,
            parentAssetId:
              input.parentAssetId === undefined ? current.parentAssetId : input.parentAssetId,
          };
          await this.checkPlacement(scope, type, next);
          if (next.parentAssetId) {
            // A part cannot contain its own ancestor.
            if (
              next.parentAssetId === id ||
              (await this.repo.ancestors(scope, next.parentAssetId)).includes(id)
            )
              throw AppError.conflict('eng.asset.cycle');
          }
          if (input.properties) this.checkValues(type, input.properties);
          const row = await this.repo.updateAsset(scope, id, {
            ...next,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.serialNumber !== undefined ? { serialNumber: input.serialNumber } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...(input.criticality ? { criticality: input.criticality } : {}),
            ...(input.installedAt !== undefined ? { installedAt: input.installedAt } : {}),
            ...(input.warrantyUntil !== undefined ? { warrantyUntil: input.warrantyUntil } : {}),
            ...(input.properties ? { properties: input.properties } : {}),
          });
          await this.audit.record({
            action: 'eng.asset.update',
            entityType: 'asset',
            entityId: id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: {
              status: current.status,
              location_id: current.locationId,
              parent: current.parentAssetId,
            },
            after: { status: row.status, location_id: row.locationId, parent: row.parentAssetId },
          });
          return row;
        }),
    );
  }

  listAssets(scope: PropertyScope, query: z.infer<typeof listAssetsSchema>) {
    return this.gate.execute(
      { action: 'eng.asset.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(() =>
          this.repo.assetsOf(scope, {
            ...(query.locationId ? { locationIds: [query.locationId] } : {}),
            ...(query.assetTypeId ? { assetTypeId: query.assetTypeId } : {}),
          }),
        ),
    );
  }

  /** The asset with its parts, its ancestors and the documents of the asset and its model. */
  getAsset(scope: PropertyScope, id: string) {
    return this.gate.execute(
      { action: 'eng.asset.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const asset = await this.find(scope, id);
          return {
            ...asset,
            parts: await this.repo.assetsOf(scope, { parentAssetId: asset.id }),
            ancestors: await this.repo.ancestors(scope, asset.id),
            documents: await this.repo.documentsFor(scope, asset),
          };
        }),
    );
  }

  /** Links a knowledge document to an asset or a model (`eng.asset.manage`). */
  linkDocument(scope: PropertyScope, input: z.infer<typeof linkDocumentSchema>) {
    return this.gate.execute(
      { action: 'eng.asset.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const doc = await this.knowledge.getDocument(scope.tenantId, input.knowledgeDocumentId);
          // A document of another property is not this asset's manual.
          if (!doc || (doc.propertyId !== null && doc.propertyId !== scope.propertyId))
            throw AppError.notFound('eng.document.not_found');
          if (input.assetId) await this.find(scope, input.assetId);
          if (input.assetModelId && !(await this.repo.assetModel(scope, input.assetModelId)))
            throw AppError.notFound('eng.asset_model.not_found');
          const row = await this.repo.insertDocument({
            id: newId(),
            tenantId: scope.tenantId,
            assetId: input.assetId ?? null,
            assetModelId: input.assetModelId ?? null,
            knowledgeDocumentId: doc.id,
            kind: input.kind,
          });
          if (!row) throw AppError.conflict('eng.document.already_linked');
          await this.audit.record({
            action: 'eng.document.link',
            entityType: 'asset_document',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: {
              document_id: doc.id,
              asset_id: row.assetId,
              asset_model_id: row.assetModelId,
              kind: row.kind,
            },
          });
          return { ...row, title: doc.title };
        }),
    );
  }

  // ---- failure taxonomy (tenant) ----

  listFailureCodes(scope: TenantScope, kind?: FailureCodeRow['kind']) {
    return this.gate.execute({ action: 'eng.asset.read', tenantId: scope.tenantId }, () =>
      this.tx.read(async () => {
        const rows = await this.repo.failureCodes(scope, kind);
        const names = await this.repo.failureCodeTranslations(rows.map((r) => r.id));
        return rows.map((r) => ({ ...r, translations: names.get(r.id) ?? [] }));
      }),
    );
  }

  createFailureCode(scope: TenantScope, input: z.infer<typeof createFailureCodeSchema>) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        if (input.assetTypeId && !(await this.repo.assetType(scope, input.assetTypeId)))
          throw AppError.notFound('eng.asset_type.not_found');
        const row = await this.repo.insertFailureCode({
          id: newId(),
          tenantId: scope.tenantId,
          kind: input.kind,
          code: input.code,
          assetTypeId: input.assetTypeId ?? null,
        });
        if (!row) throw AppError.conflict('eng.failure_code.taken');
        await this.repo.putFailureCodeTranslations(row.id, input.translations);
        await this.audit.record({
          action: 'eng.failure_code.create',
          entityType: 'failure_code',
          entityId: row.id,
          tenantId: scope.tenantId,
          after: { kind: row.kind, code: row.code },
        });
        return { ...row, translations: input.translations };
      }),
    );
  }

  /** Imports the starter taxonomy (English and Arabic names); codes the tenant already has are left alone. */
  importStarterCodes(scope: TenantScope) {
    return this.gate.execute({ action: 'eng.config.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const created: string[] = [];
        for (const s of STARTER_FAILURE_CODES) {
          const row = await this.repo.insertFailureCode({
            id: newId(),
            tenantId: scope.tenantId,
            kind: s.kind,
            code: s.code,
          });
          if (!row) continue;
          await this.repo.putFailureCodeTranslations(row.id, [
            { locale: 'en', name: s.en },
            { locale: 'ar', name: s.ar },
          ]);
          created.push(`${s.kind}:${s.code}`);
        }
        if (created.length > 0)
          await this.audit.record({
            action: 'eng.failure_code.starter',
            entityType: 'tenant',
            entityId: scope.tenantId,
            tenantId: scope.tenantId,
            after: { created: created.length },
          });
        return { created };
      }),
    );
  }

  // ---- helpers ----

  private typeView(row: AssetTypeRow, names: readonly Translation[]) {
    return { ...row, translations: names };
  }

  private async find(scope: PropertyScope, id: string): Promise<AssetRow> {
    const row = isUuid(id) ? await this.repo.asset(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId) throw AppError.notFound('eng.asset.not_found');
    return row;
  }

  private async findForUpdate(scope: PropertyScope, id: string): Promise<AssetRow> {
    const row = isUuid(id) ? await this.repo.assetForUpdate(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId) throw AppError.notFound('eng.asset.not_found');
    return row;
  }

  /** The location is the property's, the model is of the asset's type, the parent is an asset of the property. */
  private async checkPlacement(
    scope: PropertyScope,
    type: AssetTypeRow,
    input: { locationId: string; assetModelId?: string | null; parentAssetId?: string | null },
  ) {
    if (!(await this.org.getLocation(scope.tenantId, scope.propertyId, input.locationId)))
      throw AppError.notFound('org.location.not_found');
    if (input.assetModelId) {
      const model = await this.repo.assetModel(scope, input.assetModelId);
      if (!model) throw AppError.notFound('eng.asset_model.not_found');
      if (model.assetTypeId !== type.id) throw AppError.conflict('eng.asset_model.wrong_type');
    }
    if (input.parentAssetId) await this.find(scope, input.parentAssetId);
  }

  private checkValues(type: AssetTypeRow, values: Readonly<Record<string, unknown>>) {
    const problems = checkProperties(type.properties, values);
    if (problems.length > 0)
      throw new AppError('eng.asset.invalid_properties', HttpStatus.UNPROCESSABLE_ENTITY, {
        fields: problems.map((p) => `${p.key} (${p.problem})`).join(', '),
      });
  }
}
