import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  verify,
} from 'node:crypto';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import {
  isUuid,
  newId,
  type TenantScope,
  TransactionRunner,
  withTransaction,
  DATABASE,
  type Database,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { SecretResolver } from '@hotella/platform-secrets';
import { BUNDLE_MAX_SKEW_MS, bundleRequestMessage, issueBundle } from '../domain/bundle';
import { InstallationRepositories } from '../infrastructure/installation-repositories';
import type { InstallationRow } from '../infrastructure/schema';
import { EntitlementEngine } from './entitlement-engine';
import type { BundleRequestInput, CreateInstallationInput, RevokeInput } from './schemas';

const INSTALLATION = 'license.installation.manage';

/**
 * The platform's Ed25519 key that signs entitlement bundles (ADR-0021; `kv/hotella/license#bundle_signing_key`).
 * Development and tests without a reference get an ephemeral key; production refuses to issue without one.
 */
@Injectable()
export class BundleKeys {
  private key: Promise<KeyObject> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(SecretResolver) private readonly secrets: SecretResolver | null,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  signingKey(): Promise<KeyObject> {
    this.key ??= this.load();
    return this.key;
  }

  /** What a site pins (`LICENSING_BUNDLE_PUBLIC_KEY`): SPKI DER in base64. */
  async publicKey(): Promise<string> {
    return createPublicKey(await this.signingKey())
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
  }

  /** Tests inject a prepared key. */
  use(key: KeyObject): void {
    this.key = Promise.resolve(key);
  }

  private async load(): Promise<KeyObject> {
    const ref = this.config.licensing.bundleSigningKeyRef;
    if (ref) {
      if (!this.secrets)
        throw new Error('LICENSING_BUNDLE_SIGNING_KEY_REF set but no SecretResolver');
      const key = createPrivateKey(await this.secrets.resolve(ref));
      if (key.asymmetricKeyType !== 'ed25519')
        throw new Error(
          'LICENSING_BUNDLE_SIGNING_KEY_REF must point to an Ed25519 private key (PKCS#8 PEM)',
        );
      return key;
    }
    if (this.config.isProduction)
      throw new AppError('license.bundle.unavailable', HttpStatus.SERVICE_UNAVAILABLE);
    this.logger.warn('entitlement bundles: using an ephemeral signing key (development only)');
    return generateKeyPairSync('ed25519').privateKey;
  }
}

/**
 * Central management of hotel-site installations (ADR-0021): registration with the installation's public key,
 * revocation, and the signed bundle each active installation fetches with a request signed by its own key. Every
 * change and every issue is audited.
 */
@Injectable()
export class InstallationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly repo: InstallationRepositories,
    private readonly engine: EntitlementEngine,
    private readonly keys: BundleKeys,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
  ) {}

  list(scope: TenantScope) {
    return this.act('read', async () => (await this.repo.list(scope)).map(installationView));
  }

  register(scope: TenantScope, input: CreateInstallationInput) {
    return this.act('write', async () => {
      parseInstallationKey(input.publicKey);
      const actor = this.actors.require().id;
      const row = await this.repo.insert({
        id: newId(),
        tenantId: scope.tenantId,
        name: input.name,
        publicKey: input.publicKey,
        createdById: actor && isUuid(actor) ? actor : null,
      });
      await this.audit.record({
        action: 'license.installation.register',
        entityType: 'license_installation',
        entityId: row.id,
        tenantId: scope.tenantId,
        after: { name: row.name },
      });
      return installationView(row);
    });
  }

  revoke(scope: TenantScope, id: string, input: RevokeInput) {
    return this.act('write', async () => {
      const current = isUuid(id) ? await this.repo.get(scope, id) : undefined;
      if (!current) throw AppError.notFound('license.installation.not_found');
      const revoked = await this.repo.revoke(scope, id, input.reason);
      if (!revoked) throw AppError.conflict('license.installation.revoked');
      await this.audit.record({
        action: 'license.installation.revoke',
        entityType: 'license_installation',
        entityId: id,
        tenantId: scope.tenantId,
        reason: input.reason,
        before: { status: current.status },
        after: { status: revoked.status },
      });
      return installationView(revoked);
    });
  }

  /** Platform administrators read the key a site pins. */
  bundleKey() {
    return this.gate.execute({ action: INSTALLATION, tenantId: null }, async () => ({
      publicKey: await this.keys.publicKey(),
    }));
  }

  /**
   * A site asks for its bundle (no user; the installation's signature authenticates it). Refused: unknown or revoked
   * installation, bad signature, or a request time off by more than the skew (replay).
   */
  async issue(input: BundleRequestInput): Promise<{ bundle: string }> {
    const installation = isUuid(input.installationId)
      ? await this.repo.byId(input.installationId)
      : undefined;
    if (!installation)
      throw new AppError('license.bundle.request_invalid', HttpStatus.UNAUTHORIZED);
    const at = new Date(input.at);
    const fresh =
      Number.isFinite(at.getTime()) && Math.abs(Date.now() - at.getTime()) <= BUNDLE_MAX_SKEW_MS;
    const signed =
      fresh &&
      verify(
        null,
        bundleRequestMessage(installation.id, input.at),
        parseInstallationKey(installation.publicKey),
        Buffer.from(input.signature, 'base64url'),
      );
    if (!signed) throw new AppError('license.bundle.request_invalid', HttpStatus.UNAUTHORIZED);
    if (installation.status !== 'ACTIVE')
      throw new AppError('license.installation.revoked', HttpStatus.FORBIDDEN);
    const scope = { tenantId: installation.tenantId };
    return withTransaction(
      this.db,
      async () => {
        const now = new Date();
        const bundle = issueBundle({
          installationId: installation.id,
          tenantId: installation.tenantId,
          facts: await this.engine.centralFacts(installation.tenantId),
          now,
          validDays: this.config.licensing.bundleValidDays,
          graceDays: this.config.licensing.bundleGraceDays,
          key: await this.keys.signingKey(),
        });
        await this.repo.issued(scope, installation.id, now);
        await this.audit.record({
          action: 'license.bundle.issue',
          entityType: 'license_installation',
          entityId: installation.id,
          tenantId: installation.tenantId,
          actor: { type: 'INTEGRATION', id: installation.id },
          after: { issued_at: now.toISOString() },
        });
        return { bundle };
      },
      scope,
    );
  }

  private act<T>(mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    return this.gate.execute({ action: INSTALLATION, tenantId: null }, () =>
      mode === 'read' ? this.tx.read(fn) : this.tx.run(fn),
    );
  }
}

/** An installation's Ed25519 public key, SPKI DER in base64; anything else is refused. */
export function parseInstallationKey(spkiBase64: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new AppError('license.installation.key_invalid', HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw new AppError('license.installation.key_invalid', HttpStatus.UNPROCESSABLE_ENTITY);
  return key;
}

export function installationView(i: InstallationRow) {
  return {
    id: i.id,
    name: i.name,
    status: i.status,
    lastSeenAt: i.lastSeenAt,
    lastIssuedAt: i.lastIssuedAt,
    revokedAt: i.revokedAt,
    createdAt: i.createdAt,
  };
}
