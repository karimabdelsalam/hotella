import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ConfigurationChanged } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import {
  ActionGate,
  ActorStore,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
} from '@hotella/platform-auth';
import {
  DATABASE,
  type Database,
  executor,
  newId,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import {
  type ConfigScope,
  type EffectiveValue,
  type SettingDefinition,
  SettingsRegistry,
} from './registry';
import { configuration, configurationHistory, type ConfigurationRow } from './schema/settings';
import { actingTenant } from './scope';
import { SettingsReader } from './settings-reader';

export interface ScopeTarget {
  readonly scope: ConfigScope;
  /** Tenant/property scopes: platform staff name the tenant; tenant users may omit it. */
  readonly tenantId?: string | null;
  readonly propertyId?: string | null;
}

interface ResolvedTarget {
  readonly scope: ConfigScope;
  readonly tenantId: string | null;
  readonly scopeId: string | null;
  readonly propertyId: string | null;
}

/** Spec §73 hierarchical configuration with history, events and audit. */
@Injectable()
export class ConfigurationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly registry: SettingsRegistry,
    private readonly reader: SettingsReader,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly ctx: RequestContext,
    @InjectLogger() private readonly logger: Logger,
    @Optional()
    @Inject(PROPERTY_SCOPE_VERIFIER)
    private readonly properties?: PropertyScopeVerifier | null,
  ) {}

  /** Effective value for code paths (no permission check: callers already act within an authorized scope). */
  effective<T>(
    def: SettingDefinition<T>,
    at: { tenantId?: string | null; propertyId?: string | null } = {},
  ): Promise<EffectiveValue<T>> {
    return this.reader.effective(def, at);
  }

  /** Same as effective(), for an API caller holding config.read in that scope. */
  async effectiveFor(
    key: string,
    target: Omit<ScopeTarget, 'scope'>,
  ): Promise<EffectiveValue<unknown> & { key: string }> {
    const def = this.definition(key);
    const actor = this.actors.require();
    const tenantId =
      actor.isPlatformAdmin && !target.tenantId ? null : actingTenant(actor, target.tenantId);
    return this.gate.execute(
      { action: 'config.read', tenantId, propertyId: target.propertyId ?? null },
      async () => {
        if (tenantId && target.propertyId) await this.assertProperty(tenantId, target.propertyId);
        return {
          key,
          ...(await this.effective(def, { tenantId, propertyId: target.propertyId ?? null })),
        };
      },
    );
  }

  /** Overrides stored at one scope. */
  async listAt(target: ScopeTarget): Promise<ConfigurationRow[]> {
    const t = await this.target(target);
    return this.gate.execute(
      { action: 'config.read', tenantId: t.tenantId, propertyId: t.propertyId },
      async () => {
        return executor(this.db)
          .select()
          .from(configuration)
          .where(
            and(
              eq(configuration.scope, t.scope),
              t.scopeId ? eq(configuration.scopeId, t.scopeId) : isNull(configuration.scopeId),
            ),
          )
          .orderBy(asc(configuration.key));
      },
    );
  }

  async set(
    key: string,
    target: ScopeTarget,
    value: unknown,
    opts: { expectedVersion?: number; reason?: string | null } = {},
  ): Promise<ConfigurationRow> {
    const def = this.definition(key);
    const t = await this.target(target);
    if (!def.scopes.includes(t.scope))
      throw new AppError('platform.config.scope_not_allowed', HttpStatus.UNPROCESSABLE_ENTITY, {
        scope: t.scope,
      });
    const parsed = def.schema.safeParse(value);
    if (!parsed.success)
      throw new AppError('platform.config.invalid_value', HttpStatus.UNPROCESSABLE_ENTITY, { key });
    return this.gate.execute(
      { action: 'config.manage', tenantId: t.tenantId, propertyId: t.propertyId },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const current = await this.stored(key, t);
          if (
            opts.expectedVersion !== undefined &&
            (current?.version ?? 0) !== opts.expectedVersion
          )
            throw AppError.conflict('platform.conflict');
          let row: ConfigurationRow;
          if (current) {
            [row] = (await executor(this.db)
              .update(configuration)
              .set({
                value: parsed.data,
                changedBy: actor.id,
                version: sql`${configuration.version} + 1`,
              })
              .where(
                and(eq(configuration.id, current.id), eq(configuration.version, current.version)),
              )
              .returning()) as [ConfigurationRow];
            if (!row) throw AppError.conflict('platform.conflict');
          } else {
            [row] = (await executor(this.db)
              .insert(configuration)
              .values({
                id: newId(),
                tenantId: t.tenantId,
                scope: t.scope,
                scopeId: t.scopeId,
                key,
                value: parsed.data,
                changedBy: actor.id,
              })
              .returning()) as [ConfigurationRow];
          }
          await this.recordChange(
            t,
            key,
            current?.value ?? null,
            row.value,
            row.version,
            actor.id,
            opts.reason,
            false,
          );
          return row;
        }),
    );
  }

  async remove(
    key: string,
    target: ScopeTarget,
    opts: { reason?: string | null } = {},
  ): Promise<{ removed: boolean }> {
    this.definition(key);
    const t = await this.target(target);
    return this.gate.execute(
      { action: 'config.manage', tenantId: t.tenantId, propertyId: t.propertyId },
      () =>
        this.tx.run(async () => {
          const current = await this.stored(key, t);
          if (!current) return { removed: false };
          await executor(this.db).delete(configuration).where(eq(configuration.id, current.id));
          await this.recordChange(
            t,
            key,
            current.value,
            null,
            current.version + 1,
            this.actors.require().id,
            opts.reason,
            true,
          );
          return { removed: true };
        }),
    );
  }

  private definition(key: string): SettingDefinition {
    const def = this.registry.get(key);
    if (!def) throw AppError.notFound('platform.config.unknown_key', { key });
    return def;
  }

  /**
   * PLATFORM scope is for platform administrators only; tenant/property scopes resolve the acting tenant and a
   * property must belong to it (404 before any permission check, so probing never learns more than "not found").
   */
  private async target(target: ScopeTarget): Promise<ResolvedTarget> {
    const actor = this.actors.require();
    if (target.scope === 'PLATFORM') {
      if (!actor.isPlatformAdmin)
        throw AppError.forbidden('platform.forbidden', { permission: 'config.manage' });
      return { scope: 'PLATFORM', tenantId: null, scopeId: null, propertyId: null };
    }
    const tenantId = actingTenant(actor, target.tenantId);
    if (target.scope === 'TENANT')
      return { scope: 'TENANT', tenantId, scopeId: tenantId, propertyId: null };
    if (!target.propertyId)
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
    await this.assertProperty(tenantId, target.propertyId);
    return {
      scope: 'PROPERTY',
      tenantId,
      scopeId: target.propertyId,
      propertyId: target.propertyId,
    };
  }

  private async assertProperty(tenantId: string, propertyId: string): Promise<void> {
    if (this.properties && !(await this.properties.propertyBelongsToTenant(propertyId, tenantId)))
      throw AppError.notFound('org.property.not_found');
  }

  private stored(key: string, t: ResolvedTarget): Promise<ConfigurationRow | undefined> {
    return executor(this.db)
      .select()
      .from(configuration)
      .where(
        and(
          eq(configuration.key, key),
          eq(configuration.scope, t.scope),
          t.scopeId ? eq(configuration.scopeId, t.scopeId) : isNull(configuration.scopeId),
        ),
      )
      .then((r) => r[0]);
  }

  private async recordChange(
    t: ResolvedTarget,
    key: string,
    oldValue: unknown,
    newValue: unknown,
    version: number,
    actorId: string,
    reason: string | null | undefined,
    removed: boolean,
  ): Promise<void> {
    await executor(this.db)
      .insert(configurationHistory)
      .values({
        tenantId: t.tenantId,
        scope: t.scope,
        scopeId: t.scopeId,
        key,
        oldValue,
        newValue,
        version,
        changedBy: actorId,
        reason: reason ?? null,
        correlationId: this.ctx.correlationId,
      });
    await this.events.publish(ConfigurationChanged, {
      tenantId: t.tenantId,
      propertyId: t.propertyId,
      source: 'platform',
      aggregate: { type: 'configuration', id: `${t.scope}:${t.scopeId ?? '-'}:${key}` },
      payload: {
        key,
        scope: t.scope,
        scope_id: t.scopeId,
        tenant_id: t.tenantId,
        version,
        removed,
      },
    });
    await this.audit.record({
      action: removed ? 'platform.configuration.remove' : 'platform.configuration.set',
      entityType: 'configuration',
      entityId: `${t.scope}:${t.scopeId ?? '-'}:${key}`,
      tenantId: t.tenantId,
      propertyId: t.propertyId,
      before: { value: oldValue },
      after: { value: newValue },
      reason: reason ?? null,
    });
  }
}
