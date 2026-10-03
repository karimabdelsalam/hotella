import { readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from './storage.service';

const infra = readTestInfra();

describe.skipIf(!infra.s3)('StorageService against MinIO', () => {
  let storage: StorageService;
  beforeAll(async () => {
    storage = new StorageService({
      endpoint: infra.s3!.endpoint,
      region: 'us-east-1',
      bucket: infra.s3!.bucket,
      accessKey: infra.s3!.accessKey,
      secretKey: infra.s3!.secretKey,
    });
    await storage.ensureBucket();
  });
  afterAll(() => storage?.destroy());

  it('puts, reads, signs and deletes an object', async () => {
    const key = `tenants/t1/inspections/${Date.now()}.txt`;
    await storage.put({ key, body: 'مرحبا hotella', contentType: 'text/plain; charset=utf-8' });
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.getBuffer(key)).toString('utf8')).toBe('مرحبا hotella');
    const url = await storage.getSignedDownloadUrl(key, 60);
    expect(url).toContain(key);
    expect(url).toMatch(/X-Amz-Signature=/);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });
});

describe('StorageService (unit)', () => {
  it('produces presigned URLs without touching the network', async () => {
    const storage = new StorageService({
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'b',
      accessKey: 'a',
      secretKey: 's',
    });
    const url = await storage.getSignedUploadUrl('k/1.png', 'image/png', 120);
    expect(url).toMatch(/^http:\/\/localhost:9000\/b\/k\/1\.png\?/);
    expect(url).toContain('X-Amz-Expires=120');
    storage.destroy();
  });
});
