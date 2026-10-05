import { Inject, Injectable, Optional } from '@nestjs/common';
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { SecretResolver } from '@hotella/platform-secrets';
import {
  type BundleState,
  bundleRequestMessage,
  bundleState,
  publicKeyFromBase64,
  verifyBundle,
} from '../domain/bundle';
import type { TenantFacts } from '../domain/entitlements';
import { InstallationRepositories } from '../infrastructure/installation-repositories';
import type { SiteBundleRow } from '../infrastructure/schema';

export interface SiteBundleView {
  readonly tenantId: string;
  readonly facts: TenantFacts;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly graceUntil: Date;
  readonly state: BundleState;
}

const CACHE_MS = 60_000;

/**
 * A hotel-site installation's view of its licence (ADR-0021): the newest signed bundle accepted from the central control
 * plane, kept in `license.site_bundles` across restarts and re-verified against the pinned platform key when read (an
 * edited row is worthless). `renew()` asks the control plane for a fresh bundle with a request signed by this
 * installation's own key; a failed renewal changes nothing — the last bundle keeps answering until its grace ends.
 */
@Injectable()
export class SiteBundleStore {
  private cached: { value: SiteBundleView | null; at: number } | undefined;
  private installationKey: KeyObject | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: InstallationRepositories,
    @Optional() @Inject(SecretResolver) private readonly secrets: SecretResolver | null,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Tests inject the installation's key instead of a secret reference. */
  use(key: KeyObject): void {
    this.installationKey = key;
  }

  private get site() {
    const l = this.config.licensing;
    return {
      id: l.installationId!,
      url: l.controlPlaneUrl!,
      key: publicKeyFromBase64(l.bundlePublicKey!),
    };
  }

  async current(now = new Date()): Promise<SiteBundleView | null> {
    if (this.config.licensing.mode !== 'site') return null;
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) {
      const v = this.cached.value;
      return v && { ...v, state: bundleState(v, now) };
    }
    const row = await this.repo.siteBundle(this.site.id);
    const value = row ? this.view(row, now) : null;
    this.cached = { value, at: Date.now() };
    return value;
  }

  /** Fetches, verifies and stores a fresh bundle; returns false (and keeps the current one) when that fails. */
  async renew(fetchImpl: typeof fetch = fetch): Promise<boolean> {
    if (this.config.licensing.mode !== 'site') return false;
    const site = this.site;
    try {
      const at = new Date().toISOString();
      const signature = sign(null, bundleRequestMessage(site.id, at), await this.key()).toString(
        'base64url',
      );
      const res = await fetchImpl(`${site.url.replace(/\/$/, '')}/license/bundle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installationId: site.id, at, signature }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        this.logger.warn(
          { status: res.status },
          'entitlement bundle renewal refused by the control plane',
        );
        return false;
      }
      const { bundle } = (await res.json()) as { bundle: string };
      const previous = await this.repo.siteBundle(site.id);
      const verified = verifyBundle(bundle, site.key, {
        installationId: site.id,
        now: new Date(),
        newestAccepted: previous?.issuedAt ?? null,
      });
      await this.repo.saveSiteBundle({
        installationId: site.id,
        tenantId: verified.payload.tenant_id,
        token: bundle,
        issuedAt: verified.issuedAt,
        validUntil: verified.validUntil,
        graceUntil: verified.graceUntil,
        acceptedAt: new Date(),
      });
      this.cached = undefined;
      this.logger.info(
        {
          validUntil: verified.validUntil.toISOString(),
          graceUntil: verified.graceUntil.toISOString(),
        },
        'entitlement bundle renewed',
      );
      return true;
    } catch (err) {
      this.logger.warn(
        { error: (err as Error).message },
        'entitlement bundle renewal failed; keeping the current one',
      );
      return false;
    }
  }

  private view(row: SiteBundleRow, now: Date): SiteBundleView | null {
    try {
      const v = verifyBundle(row.token, this.site.key, { installationId: this.site.id, now });
      return {
        tenantId: v.payload.tenant_id,
        facts: v.facts,
        issuedAt: v.issuedAt,
        validUntil: v.validUntil,
        graceUntil: v.graceUntil,
        state: bundleState(v, now),
      };
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        'stored entitlement bundle is not valid; ignoring it',
      );
      return null;
    }
  }

  private async key(): Promise<KeyObject> {
    if (this.installationKey) return this.installationKey;
    if (!this.secrets)
      throw new Error('LICENSING_INSTALLATION_KEY_REF set but no SecretResolver is available');
    const key = createPrivateKey(
      await this.secrets.resolve(this.config.licensing.installationKeyRef!),
    );
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error(
        'LICENSING_INSTALLATION_KEY_REF must point to an Ed25519 private key (PKCS#8 PEM)',
      );
    this.installationKey = key;
    return key;
  }
}
