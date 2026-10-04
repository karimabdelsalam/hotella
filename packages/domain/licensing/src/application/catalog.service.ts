import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ActionGate } from '@hotella/platform-auth';
import { TransactionRunner } from '@hotella/platform-database';
import { CurrentLocale, I18nService } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  CAPABILITIES,
  capabilityLabelKey,
  METRICS,
  metricLabelKey,
  PRODUCT_CODE,
} from '../domain/catalog';
import type { CatalogView } from '../domain/plans';
import { CatalogRepositories } from '../infrastructure/repositories';

const RETRY_MS = 15_000;

/**
 * Keeps `license.products/capabilities/metrics` in step with the code-defined catalog (Spec §59, §61): idempotent,
 * at every boot, retried in the background while the database is unreachable. Codes that leave the catalog are
 * retired, never deleted.
 */
@Injectable()
export class LicenseCatalogService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repo: CatalogRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly i18n: I18nService,
    private readonly locale: CurrentLocale,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.attempt();
  }
  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private async attempt(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.logger.warn({ err }, 'licensing catalog sync failed; retrying');
      this.timer = setTimeout(() => void this.attempt(), RETRY_MS);
      this.timer.unref();
    }
  }

  async sync(): Promise<void> {
    await this.tx.run(async () => {
      // One sync at a time across processes (API and worker boot together).
      await this.repo.lockCatalog();
      await this.repo.upsertProduct(PRODUCT_CODE);
      await this.repo.upsertCapabilities(PRODUCT_CODE, CAPABILITIES);
      await this.repo.upsertMetrics(METRICS);
    });
  }

  /** The catalog with labels in the request's language. */
  list() {
    return this.gate.execute({ action: 'license.catalog.read', tenantId: null }, () =>
      this.tx.read(async () => {
        const locale = this.locale.get();
        const label = (key: string, code: string) =>
          this.i18n.has(key, locale) ? this.i18n.t(key, {}, locale) : code;
        const [caps, mets] = await Promise.all([this.repo.capabilities(), this.repo.metrics()]);
        return {
          product: PRODUCT_CODE,
          capabilities: caps.map((c) => ({
            code: c.code,
            kind: c.kind,
            moduleCode: c.moduleCode,
            defaultIncluded: c.defaultIncluded,
            status: c.status,
            name: label(capabilityLabelKey(c.code), c.code),
          })),
          metrics: mets.map((m) => ({
            code: m.code,
            unit: m.unit,
            kind: m.kind,
            status: m.status,
            name: label(metricLabelKey(m.code), m.code),
          })),
        };
      }),
    );
  }

  /** The catalog as the plan rules read it. */
  async view(): Promise<CatalogView> {
    const [caps, mets] = await Promise.all([this.repo.capabilities(), this.repo.metrics()]);
    return {
      capabilities: new Map(
        caps.map((c) => [
          c.code,
          { kind: c.kind, moduleCode: c.moduleCode, active: c.status === 'ACTIVE' },
        ]),
      ),
      metrics: new Map(mets.map((m) => [m.code, { kind: m.kind, active: m.status === 'ACTIVE' }])),
    };
  }
}
