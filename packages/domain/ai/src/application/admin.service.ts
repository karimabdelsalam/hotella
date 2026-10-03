import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { isSecretRef } from '@hotella/platform-secrets';
import { CAPABILITIES } from '../domain/routing';
import { AiRepositories } from '../infrastructure/repositories';
import type { ModelRow, ProviderRow, RoutingRuleRow } from '../infrastructure/schema';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const secretRef = z
  .string()
  .max(256)
  .refine((v) => isSecretRef(v), 'must be a SecretRef such as vault://ai/openai#key');
// RESTRICTED is never sent to any model (ADR-0018), so it is not a valid maximum.
const maxDataClass = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SENSITIVE']);
const price = z.number().int().min(0).max(10_000_000);

export const createProviderSchema = z.object({
  code,
  kind: z.enum(['OPENAI_COMPATIBLE', 'ANTHROPIC', 'FAKE']),
  baseUrl: z.url().nullish(),
  credentialRef: secretRef.nullish(),
  egress: z.enum(['ON_PREM', 'EXTERNAL']),
  maxDataClass: maxDataClass.default('INTERNAL'),
});
export const updateProviderSchema = z.object({
  version: z.number().int().min(1),
  baseUrl: z.url().nullish(),
  credentialRef: secretRef.nullish(),
  maxDataClass: maxDataClass.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});
export const createModelSchema = z.object({
  providerId: z.uuid(),
  code: z.string().trim().min(1).max(128),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1),
  contextWindow: z.number().int().min(512).max(10_000_000).default(8192),
  inputPerMillionMinor: price.default(0),
  outputPerMillionMinor: price.default(0),
  cachedPerMillionMinor: price.default(0),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
});
export const updateModelSchema = z.object({
  version: z.number().int().min(1),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).optional(),
  contextWindow: z.number().int().min(512).max(10_000_000).optional(),
  inputPerMillionMinor: price.optional(),
  outputPerMillionMinor: price.optional(),
  cachedPerMillionMinor: price.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});
export const routingSchema = z.object({
  capability: z.enum(CAPABILITIES),
  modelIds: z.array(z.uuid()).min(1).max(5),
  propertyId: z.uuid().nullish(),
});
export const usageQuerySchema = z.object({ from: z.iso.date().optional() });

/**
 * AI configuration (ADR-0018): providers and models are platform configuration (`ai.provider.manage`, platform
 * administrators); the platform default routing likewise; tenants override routing per capability and property
 * (`ai.routing.manage`) and read their usage (`ai.usage.read`).
 */
@Injectable()
export class AiAdminService {
  constructor(
    private readonly repo: AiRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  private platform<T>(fn: () => Promise<T>, mode: 'read' | 'write' = 'write'): Promise<T> {
    return this.gate.execute({ action: 'ai.provider.manage', tenantId: null }, () =>
      mode === 'read' ? this.tx.read(fn) : this.tx.run(fn),
    );
  }

  listProviders() {
    return this.platform(async () => (await this.repo.listProviders()).map(providerView), 'read');
  }

  createProvider(input: z.infer<typeof createProviderSchema>) {
    return this.platform(async () => {
      const row = await this.repo
        .insertProvider({
          id: newId(),
          code: input.code,
          kind: input.kind,
          baseUrl: input.baseUrl ?? null,
          credentialRef: input.credentialRef ?? null,
          egress: input.egress,
          maxDataClass: input.maxDataClass,
        })
        .catch((e: unknown) => {
          throw unique(e, 'ai.provider.code_taken');
        });
      await this.audit.record({
        action: 'ai.provider.create',
        entityType: 'ai_provider',
        entityId: row.id,
        tenantId: null,
        after: {
          code: row.code,
          kind: row.kind,
          egress: row.egress,
          maxDataClass: row.maxDataClass,
        },
      });
      return providerView(row);
    });
  }

  updateProvider(id: string, input: z.infer<typeof updateProviderSchema>) {
    return this.platform(async () => {
      const current = isUuid(id) ? await this.repo.provider(id) : undefined;
      if (!current) throw AppError.notFound('ai.provider.not_found');
      const row = await this.repo.updateProvider(id, input.version, {
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
        ...(input.maxDataClass !== undefined ? { maxDataClass: input.maxDataClass } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      });
      if (!row) throw AppError.conflict('ai.provider.version_conflict');
      await this.audit.record({
        action: 'ai.provider.update',
        entityType: 'ai_provider',
        entityId: id,
        tenantId: null,
        before: { status: current.status, maxDataClass: current.maxDataClass },
        after: {
          status: row.status,
          maxDataClass: row.maxDataClass,
          credentials_changed: input.credentialRef !== undefined,
        },
      });
      return providerView(row);
    });
  }

  listModels() {
    return this.platform(async () => (await this.repo.listModels()).map(modelView), 'read');
  }

  createModel(input: z.infer<typeof createModelSchema>) {
    return this.platform(async () => {
      if (!(await this.repo.provider(input.providerId)))
        throw new AppError('ai.provider.not_found', HttpStatus.UNPROCESSABLE_ENTITY);
      const row = await this.repo.insertModel({ id: newId(), ...input }).catch((e: unknown) => {
        throw unique(e, 'ai.model.code_taken');
      });
      await this.audit.record({
        action: 'ai.model.create',
        entityType: 'ai_model',
        entityId: row.id,
        tenantId: null,
        after: { code: row.code, capabilities: row.capabilities },
      });
      return modelView(row);
    });
  }

  updateModel(id: string, input: z.infer<typeof updateModelSchema>) {
    return this.platform(async () => {
      const current = isUuid(id) ? await this.repo.model(id) : undefined;
      if (!current) throw AppError.notFound('ai.model.not_found');
      const { version, ...values } = input;
      const row = await this.repo.updateModel(id, version, values);
      if (!row) throw AppError.conflict('ai.model.version_conflict');
      await this.audit.record({
        action: 'ai.model.update',
        entityType: 'ai_model',
        entityId: id,
        tenantId: null,
        before: { status: current.status, capabilities: current.capabilities },
        after: { status: row.status, capabilities: row.capabilities },
      });
      return modelView(row);
    });
  }

  /** The platform default for a capability (no tenant). */
  putPlatformRule(input: z.infer<typeof routingSchema>) {
    return this.platform(() => this.putRule(null, null, input));
  }

  listRules(tenantId: string) {
    return this.gate.execute({ action: 'ai.routing.manage', tenantId }, () =>
      this.tx.read(async () => (await this.repo.listRules(tenantId)).map(ruleView)),
    );
  }

  putTenantRule(tenantId: string, input: z.infer<typeof routingSchema>) {
    const propertyId = input.propertyId ?? null;
    return this.gate.execute({ action: 'ai.routing.manage', tenantId, propertyId }, () =>
      this.tx.run(async () => {
        if (propertyId && !(await this.org.getProperty(tenantId, propertyId)))
          throw AppError.notFound('org.property.not_found');
        return this.putRule(tenantId, propertyId, input);
      }),
    );
  }

  usage(tenantId: string, from?: string) {
    return this.gate.execute({ action: 'ai.usage.read', tenantId }, () =>
      this.tx.read(async () => {
        const now = new Date();
        const since = from
          ? new Date(`${from}T00:00:00Z`)
          : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        return { from: since.toISOString(), rows: await this.repo.usage({ tenantId }, since) };
      }),
    );
  }

  private async putRule(
    tenantId: string | null,
    propertyId: string | null,
    input: z.infer<typeof routingSchema>,
  ) {
    const found = await this.repo.modelsWithProviders(input.modelIds);
    for (const id of input.modelIds) {
      const m = found.find((f) => f.model.id === id);
      if (!m || !m.model.capabilities.includes(input.capability))
        throw new AppError('ai.routing.model_unsuitable', HttpStatus.UNPROCESSABLE_ENTITY, {
          capability: input.capability,
        });
    }
    const row = await this.repo.putRule({
      id: newId(),
      tenantId,
      propertyId,
      capability: input.capability,
      modelIds: input.modelIds,
    });
    await this.audit.record({
      action: 'ai.routing.put',
      entityType: 'ai_routing_rule',
      entityId: row.id,
      tenantId,
      propertyId,
      after: { capability: row.capability, models: found.map((f) => f.model.code) },
    });
    return ruleView(row);
  }
}

function providerView(p: ProviderRow) {
  return {
    id: p.id,
    code: p.code,
    kind: p.kind,
    baseUrl: p.baseUrl,
    credentialRef: p.credentialRef,
    egress: p.egress,
    maxDataClass: p.maxDataClass,
    status: p.status,
    version: p.version,
  };
}
function modelView(m: ModelRow) {
  return {
    id: m.id,
    providerId: m.providerId,
    code: m.code,
    capabilities: m.capabilities,
    contextWindow: m.contextWindow,
    inputPerMillionMinor: m.inputPerMillionMinor,
    outputPerMillionMinor: m.outputPerMillionMinor,
    cachedPerMillionMinor: m.cachedPerMillionMinor,
    currency: m.currency,
    status: m.status,
    version: m.version,
  };
}
function ruleView(r: RoutingRuleRow) {
  return {
    id: r.id,
    tenantId: r.tenantId,
    propertyId: r.propertyId,
    capability: r.capability,
    modelIds: r.modelIds,
    version: r.version,
  };
}
function unique(e: unknown, key: string): unknown {
  const c = (e as { cause?: { code?: string } }).cause?.code;
  return c === '23505' ? AppError.conflict(key) : e;
}
