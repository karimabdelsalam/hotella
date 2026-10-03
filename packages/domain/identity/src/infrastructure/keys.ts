import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { SecretResolver } from '@hotella/platform-secrets';

/**
 * Key material for staff identity, resolved once at boot from SecretRefs (ADR-0010/0011):
 *  - JWT signing key: Ed25519 private key (PKCS#8 PEM). The key id is derived from the public key so verifiers
 *    (realtime gateway, hotel agent proxy) can select it; rotation = publish both keys during the overlap window.
 *  - MFA sealing key: 32 bytes (base64) for AES-256-GCM of TOTP seeds.
 * Outside production a missing ref yields an ephemeral key with a warning; production config refuses to start.
 */
@Injectable()
export class IdentityKeys implements OnModuleInit {
  private signing?: { privateKey: KeyObject; publicKey: KeyObject; kid: string };
  private mfaKey?: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretResolver,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    if (this.signing && this.mfaKey) return;
    const { jwtSigningKeyRef, mfaKeyRef } = this.config.iam;
    let privateKey: KeyObject;
    if (jwtSigningKeyRef) {
      privateKey = createPrivateKey(await this.secrets.resolve(jwtSigningKeyRef));
      if (privateKey.asymmetricKeyType !== 'ed25519')
        throw new Error(
          'IAM_JWT_SIGNING_KEY_REF must point to an Ed25519 private key (PKCS#8 PEM)',
        );
    } else {
      privateKey = generateKeyPairSync('ed25519').privateKey;
      this.logger.warn(
        'IAM_JWT_SIGNING_KEY_REF not set: using an ephemeral signing key (sessions end on restart)',
      );
    }
    const publicKey = createPublicKey(privateKey);
    const raw = publicKey.export({ format: 'jwk' }).x ?? '';
    this.signing = { privateKey, publicKey, kid: `ed25519-${raw.slice(0, 16)}` };

    if (mfaKeyRef) {
      const key = Buffer.from(await this.secrets.resolve(mfaKeyRef), 'base64');
      if (key.length !== 32) throw new Error('IAM_MFA_KEY_REF must resolve to 32 bytes (base64)');
      this.mfaKey = key;
    } else {
      this.mfaKey = randomBytes(32);
      this.logger.warn(
        'IAM_MFA_KEY_REF not set: using an ephemeral MFA key (enrolments end on restart)',
      );
    }
  }

  get signingKey(): { privateKey: KeyObject; publicKey: KeyObject; kid: string } {
    if (!this.signing) throw new Error('IdentityKeys not loaded');
    return this.signing;
  }

  get mfaSealingKey(): Buffer {
    if (!this.mfaKey) throw new Error('IdentityKeys not loaded');
    return this.mfaKey;
  }
}
