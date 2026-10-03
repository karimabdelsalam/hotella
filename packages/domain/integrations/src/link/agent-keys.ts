import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { CertificateAuthority } from '@hotella/platform-pki';
import { SecretResolver } from '@hotella/platform-secrets';

export interface AgentKeyMaterial {
  readonly ca: CertificateAuthority;
  readonly caCertificatePem: string;
  readonly commandSigningKey: KeyObject;
  /** SPKI PEM handed to agents at enrollment; they pin it to verify command frames. */
  readonly commandSigningPublicKeyPem: string;
  readonly tlsCertificatePem: string;
  readonly tlsPrivateKeyPem: string;
}

/**
 * Key material of the agent gateway (ADR-0017 §2, §5), resolved from SecretRefs. In production every reference is
 * required; elsewhere an ephemeral CA, command key and `localhost` TLS certificate are generated (agents enrolled
 * against them must re-enroll after a restart).
 */
@Injectable()
export class AgentKeys {
  private material: Promise<AgentKeyMaterial> | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Explicit token: a `SecretResolver | null` annotation would emit `Object` as design metadata and @Optional
    // would then silently inject nothing.
    @Optional() @Inject(SecretResolver) private readonly secrets: SecretResolver | null,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  get(): Promise<AgentKeyMaterial> {
    this.material ??= this.load();
    return this.material;
  }

  /** Tests and tools inject prepared material (e.g. a CA shared with a simulator). */
  use(material: AgentKeyMaterial): void {
    this.material = Promise.resolve(material);
  }

  private async load(): Promise<AgentKeyMaterial> {
    const a = this.config.agent;
    const refs = {
      AGENT_CA_CERT_REF: a.caCertRef,
      AGENT_CA_KEY_REF: a.caKeyRef,
      AGENT_COMMAND_SIGNING_KEY_REF: a.commandSigningKeyRef,
      AGENT_TLS_CERT_REF: a.tlsCertRef,
      AGENT_TLS_KEY_REF: a.tlsKeyRef,
    };
    const missing = Object.entries(refs)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length === 0) {
      if (!this.secrets)
        throw new Error('Agent key references are set but no SecretResolver is available');
      const secrets = this.secrets;
      const [caCert, caKey, commandKey, tlsCert, tlsKey] = await Promise.all(
        Object.values(refs).map((ref) => secrets.resolve(ref!)),
      );
      const commandSigningKey = createPrivateKey(commandKey!);
      if (commandSigningKey.asymmetricKeyType !== 'ed25519')
        throw new Error(
          'AGENT_COMMAND_SIGNING_KEY_REF must point to an Ed25519 private key (PKCS#8 PEM)',
        );
      return {
        ca: await CertificateAuthority.fromPem(caCert!, caKey!),
        caCertificatePem: caCert!,
        commandSigningKey,
        commandSigningPublicKeyPem: publicPem(commandSigningKey),
        tlsCertificatePem: tlsCert!,
        tlsPrivateKeyPem: tlsKey!,
      };
    }
    if (this.config.isProduction)
      throw new Error(`Agent gateway key material missing in production: ${missing.join(', ')}`);
    this.logger.warn(
      { missing },
      'agent gateway: using an ephemeral CA and keys (development only)',
    );
    return ephemeralAgentKeys(['localhost']);
  }
}

function publicPem(key: KeyObject): string {
  return createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
}

/** Fresh CA, command key and TLS server certificate (development, tests, `pilot.sh init`). */
export async function ephemeralAgentKeys(hostnames: readonly string[]): Promise<AgentKeyMaterial> {
  const { ca, certificatePem } = await CertificateAuthority.create('Hotella Agent CA (ephemeral)');
  const server = await ca.issueServerCertificate({ hostnames, ips: ['127.0.0.1'] });
  const commandSigningKey = generateKeyPairSync('ed25519').privateKey;
  return {
    ca,
    caCertificatePem: certificatePem,
    commandSigningKey,
    commandSigningPublicKeyPem: publicPem(commandSigningKey),
    tlsCertificatePem: server.certificatePem,
    tlsPrivateKeyPem: server.privateKeyPem,
  };
}
