import 'reflect-metadata';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
  webcrypto,
  X509Certificate as NodeX509,
} from 'node:crypto';
import * as x509 from '@peculiar/x509';

/**
 * Planova agent PKI (ADR-0017 §2, §5). The platform CA signs hotel-agent device certificates from CSRs (the agent's
 * private key never leaves the hotel); mutual TLS then makes the certificate the agent's identity. Keys are ECDSA
 * P-256 (supported by OpenSSL/Node and by .NET's TLS stack on Windows and Linux). Command frames are additionally
 * signed with Ed25519 (`signCanonical`).
 */

type CryptoKey = webcrypto.CryptoKey;
type EcKeyAlgorithm = webcrypto.EcKeyAlgorithm;

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY_MS = 86_400_000;

export interface IssuedCertificate {
  readonly certificatePem: string;
  readonly serialNumber: string;
  /** SHA-256 fingerprint, lower-case hex without separators. */
  readonly fingerprint: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export class CsrRejectedError extends Error {
  constructor(reason: string) {
    super(`certificate request rejected: ${reason}`);
    this.name = 'CsrRejectedError';
  }
}

async function importEcPrivateKey(pem: string): Promise<CryptoKey> {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('expected an ECDSA P-256 private key');
  return key.toCryptoKey(EC, true, ['sign']) as CryptoKey;
}

function exportPrivateKeyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function randomSerial(): string {
  // 16 random bytes, high bit cleared so the DER integer stays positive (RFC 5280 §4.1.2.2).
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f;
  return b.toString('hex');
}

export function fingerprintOf(certificatePem: string): string {
  return new NodeX509(certificatePem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** URIs in the certificate's subjectAltName (e.g. `urn:hotella:instance:<id>`). */
export function certificateUris(certificatePem: string): string[] {
  const san = new NodeX509(certificatePem).subjectAltName ?? '';
  return san
    .split(/,\s*/)
    .filter((s) => s.startsWith('URI:'))
    .map((s) => s.slice(4));
}

export class CertificateAuthority {
  private constructor(
    private readonly cert: x509.X509Certificate,
    private readonly key: CryptoKey,
  ) {}

  /** Loads the CA from its certificate and ECDSA P-256 private key (PEM, typically resolved from SecretRefs). */
  static async fromPem(
    certificatePem: string,
    privateKeyPem: string,
  ): Promise<CertificateAuthority> {
    return new CertificateAuthority(
      new x509.X509Certificate(certificatePem),
      await importEcPrivateKey(privateKeyPem),
    );
  }

  /** A new self-signed CA (development, tests, and the pilot's one-time `pilot.sh init`). */
  static async create(
    commonName: string,
    validityDays = 3650,
  ): Promise<{ ca: CertificateAuthority; certificatePem: string; privateKeyPem: string }> {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keys = {
      privateKey: privateKey.toCryptoKey(EC, true, ['sign']) as CryptoKey,
      publicKey: createPublicKey(privateKey).toCryptoKey(EC, true, ['verify']) as CryptoKey,
    };
    const now = Date.now();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerial(),
      name: `CN=${commonName}, O=Planova`,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + validityDays * DAY_MS),
      signingAlgorithm: SIGNING,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    return {
      ca: new CertificateAuthority(cert, keys.privateKey),
      certificatePem: cert.toString('pem'),
      privateKeyPem: exportPrivateKeyPem(privateKey),
    };
  }

  get certificatePem(): string {
    return this.cert.toString('pem');
  }

  /**
   * Signs a device certificate for a verified CSR. Only the CSR's public key is used: the subject and SAN come from
   * the platform (the requester cannot choose its identity). P-256 keys only.
   */
  async issueClientCertificate(
    csrPem: string,
    identity: {
      readonly commonName: string;
      readonly uris: readonly string[];
      readonly validityDays: number;
    },
  ): Promise<IssuedCertificate> {
    let csr: x509.Pkcs10CertificateRequest;
    try {
      csr = new x509.Pkcs10CertificateRequest(csrPem);
    } catch {
      throw new CsrRejectedError('not a PKCS#10 request');
    }
    if (!(await csr.verify())) throw new CsrRejectedError('signature does not verify');
    const algorithm = csr.publicKey.algorithm as EcKeyAlgorithm;
    if (algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256')
      throw new CsrRejectedError('key must be ECDSA P-256');
    return this.issue({
      subject: `CN=${identity.commonName}, O=Planova Hotel Agent`,
      publicKey: csr.publicKey,
      validityDays: identity.validityDays,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
        new x509.SubjectAlternativeNameExtension(
          identity.uris.map((value) => ({ type: 'url' as const, value })),
        ),
      ],
    });
  }

  /** A TLS server certificate with a fresh key (the gateway in development, tests and the pilot). */
  async issueServerCertificate(options: {
    readonly hostnames: readonly string[];
    readonly ips?: readonly string[];
    readonly validityDays?: number;
  }): Promise<IssuedCertificate & { privateKeyPem: string }> {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicKey = createPublicKey(privateKey).toCryptoKey(EC, true, ['verify']) as CryptoKey;
    const issued = await this.issue({
      subject: `CN=${options.hostnames[0] ?? 'localhost'}`,
      publicKey,
      validityDays: options.validityDays ?? 397,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([
          ...options.hostnames.map((value) => ({ type: 'dns' as const, value })),
          ...(options.ips ?? []).map((value) => ({ type: 'ip' as const, value })),
        ]),
      ],
    });
    return { ...issued, privateKeyPem: exportPrivateKeyPem(privateKey) };
  }

  private async issue(params: {
    subject: string;
    publicKey: x509.PublicKey | CryptoKey;
    validityDays: number;
    extensions: x509.Extension[];
  }): Promise<IssuedCertificate> {
    const now = Date.now();
    const serialNumber = randomSerial();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject: params.subject,
      issuer: this.cert.subject,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + params.validityDays * DAY_MS),
      signingAlgorithm: SIGNING,
      publicKey: params.publicKey,
      signingKey: this.key,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        await x509.AuthorityKeyIdentifierExtension.create(this.cert),
        await x509.SubjectKeyIdentifierExtension.create(params.publicKey as CryptoKey),
        ...params.extensions,
      ],
    });
    const certificatePem = cert.toString('pem');
    return {
      certificatePem,
      serialNumber,
      fingerprint: fingerprintOf(certificatePem),
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
    };
  }
}

/** What an agent does at enrollment: a fresh P-256 key (kept locally) and a CSR for it. */
export async function createKeyAndCsr(
  commonName: string,
): Promise<{ privateKeyPem: string; csrPem: string }> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keys = {
    privateKey: privateKey.toCryptoKey(EC, true, ['sign']) as CryptoKey,
    publicKey: createPublicKey(privateKey).toCryptoKey(EC, true, ['verify']) as CryptoKey,
  };
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${commonName}`,
    keys,
    signingAlgorithm: SIGNING,
  });
  return { privateKeyPem: exportPrivateKeyPem(privateKey), csrPem: csr.toString('pem') };
}

/** Deterministic JSON (sorted keys, no whitespace) — the exact bytes a command signature covers. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Ed25519 signature (base64url) over the canonical JSON of `value` (ADR-0017 §5 signed command frames). */
export function signCanonical(value: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(value)), privateKey).toString('base64url');
}

export function verifyCanonical(value: unknown, signature: string, publicKey: KeyObject): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(value)),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
