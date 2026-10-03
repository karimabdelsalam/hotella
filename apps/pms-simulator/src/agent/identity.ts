import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import {
  ENROLL_PATH,
  type EnrollResponse,
  enrollResponseSchema,
} from '@hotella/contracts-connectors';
import { createKeyAndCsr } from '@hotella/platform-pki';

/** What the agent keeps after enrollment. The private key never leaves the machine (ADR-0017 §2). */
export interface AgentIdentity {
  readonly instanceId: string;
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** The Planova CA: verifies the gateway's TLS certificate (pinned) and issued our certificate. */
  readonly caCertificatePem: string;
  /** Pinned Ed25519 key that every command frame must be signed with. */
  readonly commandPublicKeyPem: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`HTTP ${status} ${code}`);
    this.name = 'HttpError';
  }
}

/** POSTs JSON to the gateway with the pinned CA (and, after enrollment, the client certificate). */
export function postJson<T>(
  gatewayUrl: string,
  path: string,
  body: unknown,
  tls: { ca: string; cert?: string; key?: string },
): Promise<T> {
  const url = new URL(path, gatewayUrl);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        minVersion: 'TLSv1.3',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-JSON error page */
          }
          if ((res.statusCode ?? 500) >= 400)
            return reject(
              new HttpError(
                res.statusCode ?? 500,
                (json as { code?: string } | null)?.code ?? 'error',
              ),
            );
          resolve(json as T);
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** One-time enrollment: local key + CSR, exchanged with the single-use token for a device certificate. */
export async function enroll(options: {
  gatewayUrl: string;
  token: string;
  caCertificatePem: string;
  agentVersion: string;
}): Promise<AgentIdentity> {
  const { privateKeyPem, csrPem } = await createKeyAndCsr('hotella-agent');
  const raw = await postJson<EnrollResponse>(
    options.gatewayUrl,
    ENROLL_PATH,
    { token: options.token, csr: csrPem, agent_version: options.agentVersion },
    { ca: options.caCertificatePem },
  );
  const res = enrollResponseSchema.parse(raw);
  return {
    instanceId: res.instance_id,
    privateKeyPem,
    certificatePem: res.certificate,
    caCertificatePem: res.ca_certificate,
    commandPublicKeyPem: res.command_signing_public_key,
  };
}

export function saveIdentity(dir: string, identity: AgentIdentity): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(identity, null, 2), { mode: 0o600 });
}

export function loadIdentity(dir: string): AgentIdentity | null {
  const file = join(dir, 'identity.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AgentIdentity) : null;
}
