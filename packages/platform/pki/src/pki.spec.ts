import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  CertificateAuthority,
  certificateUris,
  createKeyAndCsr,
  CsrRejectedError,
  fingerprintOf,
  signCanonical,
  verifyCanonical,
} from './index';

describe('agent PKI', () => {
  it('issues a device certificate from a CSR with the identity chosen by the platform', async () => {
    const { ca, certificatePem: caPem } = await CertificateAuthority.create('Test Agent CA');
    const { csrPem } = await createKeyAndCsr('requested-name-is-ignored');
    const issued = await ca.issueClientCertificate(csrPem, {
      commonName: 'instance:abc',
      uris: ['urn:hotella:instance:abc', 'urn:hotella:tenant:t1'],
      validityDays: 90,
    });
    const cert = new X509Certificate(issued.certificatePem);
    expect(cert.subject).toContain('CN=instance:abc');
    expect(cert.verify(new X509Certificate(caPem).publicKey)).toBe(true);
    expect(cert.checkIssued(new X509Certificate(caPem))).toBe(true);
    expect(certificateUris(issued.certificatePem)).toEqual([
      'urn:hotella:instance:abc',
      'urn:hotella:tenant:t1',
    ]);
    expect(fingerprintOf(issued.certificatePem)).toBe(issued.fingerprint);
    expect(issued.notAfter.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    // Round-trip through PEM, as the gateway loads the CA from its secret store.
    const created = await CertificateAuthority.create('Reloaded CA');
    const reloaded = await CertificateAuthority.fromPem(
      created.certificatePem,
      created.privateKeyPem,
    );
    const again = await reloaded.issueClientCertificate((await createKeyAndCsr('y')).csrPem, {
      commonName: 'instance:y',
      uris: [],
      validityDays: 1,
    });
    expect(
      new X509Certificate(again.certificatePem).checkIssued(
        new X509Certificate(created.certificatePem),
      ),
    ).toBe(true);
  });

  it('rejects malformed requests and non-P-256 keys', async () => {
    const { ca } = await CertificateAuthority.create('Test Agent CA');
    const id = { commonName: 'x', uris: [], validityDays: 1 };
    await expect(ca.issueClientCertificate('garbage', id)).rejects.toBeInstanceOf(CsrRejectedError);
    const { csrPem } = await createKeyAndCsr('x');
    // Flip one byte inside the signed request info (the subject name).
    const der = Buffer.from(csrPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    const at = der.indexOf(Buffer.from('x'));
    der.writeUInt8(der.readUInt8(at) ^ 0x01, at);
    const tampered = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64')}\n-----END CERTIFICATE REQUEST-----\n`;
    await expect(ca.issueClientCertificate(tampered, id)).rejects.toBeInstanceOf(CsrRejectedError);
  });

  it('signs command frames over canonical JSON with Ed25519', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const frame = { b: 1, a: { d: [1, 'x'], c: null }, z: undefined };
    expect(canonicalJson(frame)).toBe('{"a":{"c":null,"d":[1,"x"]},"b":1}');
    const sig = signCanonical(frame, privateKey);
    expect(verifyCanonical({ a: { c: null, d: [1, 'x'] }, b: 1 }, sig, publicKey)).toBe(true);
    expect(verifyCanonical({ ...frame, b: 2 }, sig, publicKey)).toBe(false);
  });
});
