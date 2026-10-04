/**
 * Test-infrastructure environment contract. These are the ONLY env vars tests read, and only through
 * these helpers (the lint exception for this package is scoped to this file).
 *
 *  TEST_DATABASE_URL / TEST_VALKEY_URL / TEST_S3_*  — set by CI service containers or by the Vitest
 *  global setup after starting Testcontainers. When neither is possible (no Docker), the setup sets
 *  TEST_INFRA_UNAVAILABLE=<reason> and integration suites skip with that reason.
 *  TEST_DOTNET_AGENT — the .NET hotel agent's build output (`apps/hotel-agent/artifacts/bin`); its cross-language
 *  conformance suite runs only when it is set (CI builds the agent and sets it).
 */
/* eslint-disable no-restricted-properties */
export interface TestInfra {
  readonly databaseUrl?: string;
  readonly valkeyUrl?: string;
  readonly s3?: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
  readonly unavailableReason?: string;
  readonly dotnetAgent?: string;
}

export function readTestInfra(): TestInfra {
  const e = process.env;
  return {
    databaseUrl: e['TEST_DATABASE_URL'] || undefined,
    valkeyUrl: e['TEST_VALKEY_URL'] || undefined,
    s3:
      e['TEST_S3_ENDPOINT'] && e['TEST_S3_ACCESS_KEY'] && e['TEST_S3_SECRET_KEY']
        ? {
            endpoint: e['TEST_S3_ENDPOINT'],
            accessKey: e['TEST_S3_ACCESS_KEY'],
            secretKey: e['TEST_S3_SECRET_KEY'],
            bucket: e['TEST_S3_BUCKET'] ?? 'hotella-test',
          }
        : undefined,
    unavailableReason: e['TEST_INFRA_UNAVAILABLE'] || undefined,
    dotnetAgent: e['TEST_DOTNET_AGENT'] || undefined,
  };
}

export function writeTestInfra(values: Record<string, string>): void {
  for (const [k, v] of Object.entries(values)) process.env[k] = v;
}

/** `describe.skipIf(needsInfra())` — true when no database is reachable for integration tests. */
export function needsInfra(): boolean {
  return !readTestInfra().databaseUrl;
}
export function infraSkipReason(): string {
  return readTestInfra().unavailableReason ?? 'TEST_DATABASE_URL not set';
}
