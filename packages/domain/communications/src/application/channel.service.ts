import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { isSecretRef, SecretResolver } from '@hotella/platform-secrets';
import { CommsRepositories } from '../infrastructure/repositories';
import type { ChannelRow } from '../infrastructure/schema';
import { type ChannelAdapter, ChannelAdapterRegistry, type ProviderContext } from './providers';

const secretRef = z
  .string()
  .max(256)
  .refine((v) => isSecretRef(v), 'must be a SecretRef such as vault://comms/whatsapp#token');

export const createChannelSchema = z.object({
  /** Adapter-backed channel types; web and QR entry points need no channel row. */
  type: z.enum(['WHATSAPP', 'SMS', 'VOICE']),
  name: z.string().trim().min(1).max(80),
  providerCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  config: z.record(z.string(), z.unknown()).default({}),
  credentialRef: secretRef,
});
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credentialRef: secretRef.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

/** Resolves a channel's adapter and builds its call context (credentials resolved lazily, never stored or logged). */
@Injectable()
export class ChannelRuntime {
  constructor(
    private readonly adapters: ChannelAdapterRegistry,
    @Optional() @Inject(SecretResolver) private readonly secrets?: SecretResolver,
  ) {}

  adapterFor(channel: ChannelRow): ChannelAdapter {
    const adapter = this.adapters.get(channel.providerCode);
    if (!adapter || adapter.channelType !== channel.type)
      throw new AppError('comms.channel.adapter_unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    return adapter;
  }

  context(channel: ChannelRow): ProviderContext {
    const adapter = this.adapterFor(channel);
    const parsed = adapter.configSchema.safeParse(channel.config);
    if (!parsed.success)
      throw new AppError('comms.channel.config_invalid', HttpStatus.SERVICE_UNAVAILABLE);
    const ref = channel.credentialRef;
    return {
      channelId: channel.id,
      tenantId: channel.tenantId,
      propertyId: channel.propertyId,
      config: parsed.data,
      credential: async () => {
        if (!ref || !this.secrets)
          throw new AppError(
            'comms.channel.credentials_unavailable',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        return this.secrets.resolve(ref);
      },
    };
  }
}

/** Channel administration (permission `channel.manage`; Spec §18, ADR-0015). */
@Injectable()
export class ChannelAdminService {
  constructor(
    private readonly repo: CommsRepositories,
    private readonly adapters: ChannelAdapterRegistry,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  list(scope: PropertyScope) {
    return this.act(scope, 'read', async () => (await this.repo.listChannels(scope)).map(view));
  }

  get(scope: PropertyScope, id: string) {
    return this.act(scope, 'read', async () => view(await this.find(scope, id)));
  }

  create(scope: PropertyScope, input: CreateChannelInput) {
    return this.act(scope, 'write', async () => {
      const config = this.validConfig(input.type, input.providerCode, input.config);
      const row = await this.repo
        .insertChannel({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          type: input.type,
          name: input.name,
          providerCode: input.providerCode,
          config,
          credentialRef: input.credentialRef,
        })
        .catch((e: unknown) => {
          throw uniqueName(e);
        });
      await this.audit.record({
        action: 'comms.channel.create',
        entityType: 'channel',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { type: row.type, name: row.name, provider: row.providerCode },
      });
      return view(row);
    });
  }

  update(scope: PropertyScope, id: string, input: UpdateChannelInput) {
    return this.act(scope, 'write', async () => {
      const current = await this.find(scope, id);
      const config =
        input.config !== undefined
          ? this.validConfig(current.type, current.providerCode, input.config)
          : undefined;
      const row = await this.repo
        .updateChannel(scope, current.id, input.version, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          // New credentials or configuration get a fresh chance.
          ...(input.credentialRef !== undefined || config !== undefined
            ? { health: 'HEALTHY' as const, healthChangedAt: new Date() }
            : {}),
        })
        .catch((e: unknown) => {
          throw uniqueName(e);
        });
      if (!row) throw AppError.conflict('comms.channel.version_conflict');
      await this.audit.record({
        action: 'comms.channel.update',
        entityType: 'channel',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { name: current.name, status: current.status },
        after: {
          name: row.name,
          status: row.status,
          config_changed: config !== undefined,
          credentials_changed: input.credentialRef !== undefined,
        },
      });
      return view(row);
    });
  }

  private validConfig(
    type: ChannelRow['type'],
    providerCode: string,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const adapter = this.adapters.get(providerCode);
    if (!adapter || adapter.channelType !== type)
      throw new AppError('comms.channel.unknown_provider', HttpStatus.UNPROCESSABLE_ENTITY, {
        provider: providerCode,
      });
    const parsed = adapter.configSchema.safeParse(config);
    if (!parsed.success)
      throw new AppError('comms.channel.config_invalid', HttpStatus.UNPROCESSABLE_ENTITY);
    return parsed.data;
  }

  private async find(scope: PropertyScope, id: string): Promise<ChannelRow> {
    const row = isUuid(id) ? await this.repo.channel(scope, id) : undefined;
    if (!row) throw AppError.notFound('comms.channel.not_found');
    return row;
  }

  private act<T>(scope: PropertyScope, mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'channel.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (mode === 'read' ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}

function view(c: ChannelRow) {
  return {
    id: c.id,
    propertyId: c.propertyId,
    type: c.type,
    name: c.name,
    providerCode: c.providerCode,
    config: c.config,
    credentialRef: c.credentialRef,
    status: c.status,
    health: c.health,
    healthChangedAt: c.healthChangedAt,
    version: c.version,
    createdAt: c.createdAt,
  };
}

function uniqueName(e: unknown): unknown {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  return code === '23505' ? AppError.conflict('comms.channel.name_taken') : e;
}
