import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '@hotella/platform-config';
import { LOGGER } from '@hotella/platform-observability';
import { CertificateAuthority } from '@hotella/platform-pki';
import { EnvSecretProvider, SecretResolver } from '@hotella/platform-secrets';
import { AgentKeys } from './agent-keys';

const silent = { warn: () => undefined, info: () => undefined, error: () => undefined };

describe('AgentKeys', () => {
  it('resolves its key material through the injected SecretResolver', async () => {
    const { ca, certificatePem, privateKeyPem } =
      await CertificateAuthority.create('Test Agent CA');
    const server = await ca.issueServerCertificate({ hostnames: ['localhost'], ips: [] });
    const env = {
      CA_CERT: certificatePem,
      CA_KEY: privateKeyPem,
      CMD_KEY: generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      TLS_CERT: server.certificatePem,
      TLS_KEY: server.privateKeyPem,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentKeys,
        { provide: SecretResolver, useValue: new SecretResolver([new EnvSecretProvider(env)]) },
        { provide: LOGGER, useValue: silent },
        {
          provide: APP_CONFIG,
          useValue: {
            isProduction: true,
            agent: {
              caCertRef: 'env://CA_CERT',
              caKeyRef: 'env://CA_KEY',
              commandSigningKeyRef: 'env://CMD_KEY',
              tlsCertRef: 'env://TLS_CERT',
              tlsKeyRef: 'env://TLS_KEY',
            },
          },
        },
      ],
    }).compile();
    const material = await moduleRef.get(AgentKeys).get();
    expect(material.caCertificatePem).toBe(certificatePem);
    expect(material.tlsCertificatePem).toBe(server.certificatePem);
    expect(material.commandSigningKey.asymmetricKeyType).toBe('ed25519');
  });
});
