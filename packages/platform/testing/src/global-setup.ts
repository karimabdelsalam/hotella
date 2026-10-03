import { isContainerRuntimeAvailable, startMinio, startPostgres, startValkey } from './containers';
import { readTestInfra, writeTestInfra } from './env';

/**
 * Vitest globalSetup. Order of preference:
 *  1. CI service containers already exposed via TEST_* env → use them, start nothing.
 *  2. Docker available → start Testcontainers once per run and export their URLs.
 *  3. Neither → mark infra unavailable; integration suites skip with a reason (unit tests still run).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const existing = readTestInfra();
  const needPg = !existing.databaseUrl;
  const needValkey = !existing.valkeyUrl;
  const needS3 = !existing.s3;
  if (!needPg && !needValkey && !needS3) return async () => undefined;

  if (!(await isContainerRuntimeAvailable())) {
    if (needPg)
      writeTestInfra({
        TEST_INFRA_UNAVAILABLE:
          'no container runtime (Docker) reachable and TEST_DATABASE_URL not set',
      });
    return async () => undefined;
  }

  const stops: Array<() => Promise<unknown>> = [];
  const [pg, valkey, minio] = await Promise.all([
    needPg ? startPostgres() : undefined,
    needValkey ? startValkey() : undefined,
    needS3 ? startMinio() : undefined,
  ]);
  if (pg) {
    writeTestInfra({ TEST_DATABASE_URL: pg.getConnectionUri() });
    stops.push(() => pg.stop());
  }
  if (valkey) {
    writeTestInfra({ TEST_VALKEY_URL: valkey.getConnectionUrl() });
    stops.push(() => valkey.stop());
  }
  if (minio) {
    writeTestInfra({
      TEST_S3_ENDPOINT: minio.endpoint,
      TEST_S3_ACCESS_KEY: minio.accessKey,
      TEST_S3_SECRET_KEY: minio.secretKey,
      TEST_S3_BUCKET: 'hotella-test',
    });
    stops.push(() => minio.container.stop());
  }
  return async () => {
    await Promise.all(stops.map((s) => s()));
  };
}
