import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { DATABASE, type Database, executor } from '@hotella/platform-database';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  type ConfigScope,
  type EffectiveValue,
  resolveEffective,
  type SettingDefinition,
} from './registry';
import { configuration } from './schema/settings';

/**
 * Effective configuration values for code paths, without HTTP routes or permission checks (callers already act within
 * an authorized scope). Processes without the settings API (the worker) read policy through this.
 */
@Injectable()
export class SettingsReader {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async effective<T>(
    def: SettingDefinition<T>,
    at: { tenantId?: string | null; propertyId?: string | null } = {},
  ): Promise<EffectiveValue<T>> {
    const tenantId = at.tenantId ?? null;
    const propertyId = at.propertyId ?? null;
    const scopes = [and(eq(configuration.scope, 'PLATFORM'), isNull(configuration.scopeId))];
    if (tenantId)
      scopes.push(and(eq(configuration.scope, 'TENANT'), eq(configuration.scopeId, tenantId)));
    if (tenantId && propertyId)
      scopes.push(
        and(
          eq(configuration.scope, 'PROPERTY'),
          eq(configuration.scopeId, propertyId),
          eq(configuration.tenantId, tenantId),
        ),
      );
    const rows = await executor(this.db)
      .select()
      .from(configuration)
      .where(and(eq(configuration.key, def.key), or(...scopes)));
    return resolveEffective(
      def,
      rows.map((r) => ({ scope: r.scope as ConfigScope, value: r.value, version: r.version })),
      (scope) =>
        this.logger.warn({ key: def.key, scope }, 'stored configuration value rejected by schema'),
    );
  }

  /** The value only. */
  async value<T>(
    def: SettingDefinition<T>,
    at: { tenantId?: string | null; propertyId?: string | null } = {},
  ): Promise<T> {
    return (await this.effective(def, at)).value;
  }
}
