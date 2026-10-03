import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { I18nService } from '@hotella/platform-i18n';
import { ManifestRegistry } from '@hotella/platform-manifest';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { MembershipPermissionResolver } from '../auth/permission-resolver';
import { roleDescriptionKey, roleNameKey, SYSTEM_ROLES } from '../domain/system-roles';
import { IdentityRepositories } from '../infrastructure/repositories';

const RETRY_MS = 15_000;

/**
 * Keeps the database catalog in step with code (Spec §76): the permission catalog comes from every module manifest,
 * system roles from `SYSTEM_ROLES`, their names from the locale catalog. Idempotent; runs at every boot and retries
 * in the background while the database is unreachable so the API can still start and report /ready honestly.
 */
@Injectable()
export class IdentityCatalogService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private synced = false;

  constructor(
    private readonly repo: IdentityRepositories,
    private readonly manifests: ManifestRegistry,
    private readonly i18n: I18nService,
    private readonly tx: TransactionRunner,
    private readonly resolver: MembershipPermissionResolver,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    void this.attempt();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  get isSynced(): boolean {
    return this.synced;
  }

  private async attempt(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.logger.warn({ err }, 'identity catalog sync failed; retrying');
      this.timer = setTimeout(() => void this.attempt(), RETRY_MS);
      this.timer.unref();
    }
  }

  async sync(): Promise<void> {
    const permissions = this.manifests.permissions();
    const known = new Set(permissions.map((p) => p.code));
    // A permission of a module this process does not load (e.g. a test app without the integrations context) is
    // skipped; an unknown permission of a loaded module is a typo and stops the boot. The full catalog is pinned by
    // the system-role unit test against every manifest.
    const loadedDomains = new Set(permissions.map((p) => p.code.split('.')[0]));
    const deployed = (codes: readonly string[]) => codes.filter((p) => known.has(p));
    // Processes load different slices (the API everything, the admin CLI only organization and identity): each sync
    // only adds and removes grants of the modules it knows, so a partial process never strips the others' grants.
    const loadedModules = new Set(permissions.map((p) => p.module));
    for (const role of SYSTEM_ROLES) {
      const unknown = role.permissions.filter(
        (p) => !known.has(p) && loadedDomains.has(p.split('.')[0]),
      );
      if (unknown.length > 0)
        throw new Error(
          `System role ${role.code} references undeclared permissions: ${unknown.join(', ')}`,
        );
    }
    await this.tx.run(async () => {
      await this.repo.upsertPermissions(
        permissions.map((p) => ({
          code: p.code,
          module: p.module,
          risk: p.risk as 'READ' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
          descriptionKey: p.descriptionKey,
        })),
      );
      for (const def of SYSTEM_ROLES) {
        const role =
          (await this.repo.systemRoleByCode(def.code)) ??
          (await this.repo.insertRole({
            id: newId(),
            tenantId: null,
            code: def.code,
            isSystem: true,
          }));
        await this.repo.upsertRoleTranslations(
          role.id,
          this.i18n.supportedLocales.map((locale) => ({
            locale,
            name: this.i18n.t(roleNameKey(def.code), {}, locale),
            description: this.i18n.t(roleDescriptionKey(def.code), {}, locale),
          })),
        );
        await this.repo.replaceRolePermissions(role.id, deployed(def.permissions), loadedModules);
      }
    });
    this.resolver.invalidate();
    this.synced = true;
    this.logger.info(
      { permissions: permissions.length, systemRoles: SYSTEM_ROLES.length },
      'identity catalog synced',
    );
  }
}
