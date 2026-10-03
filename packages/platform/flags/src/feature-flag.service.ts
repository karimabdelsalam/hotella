import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { FeatureFlagChanged } from '@hotella/contracts-events';
import {
  DATABASE,
  type Database,
  executor,
  platform,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { type FlagContext, type FlagRow, type FlagScope, resolveFlag } from './resolve';

export interface SetFlagInput {
  readonly key: string;
  readonly scope: FlagScope;
  readonly scopeId?: string | null;
  readonly enabled: boolean;
  readonly description?: string | null;
}

const SNAPSHOT_TTL_MS = 10_000;

/**
 * Feature flags are release control (beta, canary, experiments, emergency off) — never licensing:
 * `EntitlementEngine.can(...)` answers "did the customer buy it?", this answers "is the code path on here?".
 * Reads come from a per-process snapshot refreshed every 10 s (flags are few and read on hot paths).
 */
@Injectable()
export class FeatureFlagService {
  private snapshot: { rows: FlagRow[]; loadedAt: number } | null = null;
  private loading: Promise<FlagRow[]> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async isEnabled(key: string, ctx: FlagContext = {}): Promise<boolean> {
    return resolveFlag(await this.rows(), key, ctx);
  }

  async list(): Promise<FlagRow[]> {
    return this.rows(true);
  }

  /** Upserts the flag and publishes platform.feature_flag.changed.v1 in the same transaction. */
  async set(input: SetFlagInput): Promise<void> {
    const scopeId = input.scope === 'PLATFORM' ? null : (input.scopeId ?? null);
    if (input.scope !== 'PLATFORM' && !scopeId)
      throw new Error(`scopeId is required for ${input.scope} flags`);
    await this.runner.run(async () => {
      await executor(this.db)
        .insert(platform.featureFlags)
        .values({
          key: input.key,
          scope: input.scope,
          scopeId,
          enabled: input.enabled,
          description: input.description ?? null,
        })
        .onConflictDoUpdate({
          target: [
            platform.featureFlags.key,
            platform.featureFlags.scope,
            platform.featureFlags.scopeId,
          ],
          set: {
            enabled: input.enabled,
            description: input.description ?? null,
            updatedAt: sql`now()`,
          },
        });
      await this.publisher.publish(FeatureFlagChanged, {
        tenantId: input.scope === 'TENANT' ? scopeId : null,
        propertyId: input.scope === 'PROPERTY' ? scopeId : null,
        source: 'platform.flags',
        aggregate: { type: 'feature_flag', id: input.key },
        payload: { key: input.key, scope: input.scope, scope_id: scopeId, enabled: input.enabled },
      });
    });
    this.invalidate();
    this.logger.info(
      { key: input.key, scope: input.scope, scope_id: scopeId, enabled: input.enabled },
      'feature flag set',
    );
  }

  invalidate(): void {
    this.snapshot = null;
  }

  private async rows(fresh = false): Promise<FlagRow[]> {
    const now = Date.now();
    if (!fresh && this.snapshot && now - this.snapshot.loadedAt < SNAPSHOT_TTL_MS)
      return this.snapshot.rows;
    if (!this.loading) {
      this.loading = this.db
        .select({
          key: platform.featureFlags.key,
          scope: platform.featureFlags.scope,
          scopeId: platform.featureFlags.scopeId,
          enabled: platform.featureFlags.enabled,
        })
        .from(platform.featureFlags)
        .then((rows) => {
          this.snapshot = { rows, loadedAt: Date.now() };
          return rows;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }
}
