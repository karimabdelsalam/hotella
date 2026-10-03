import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';

export const IMAGES = {
  postgres: 'pgvector/pgvector:pg18',
  valkey: 'valkey/valkey:9',
  // Docker Hub's minio/minio is no longer pullable (2026); the project publishes to quay.io.
  minio: 'quay.io/minio/minio:latest',
} as const;

/** True when a container runtime (Docker/Podman) is reachable. Never throws. */
export async function isContainerRuntimeAvailable(): Promise<boolean> {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(IMAGES.postgres)
    .withDatabase('hotella_test')
    .withUsername('hotella')
    .withPassword('hotella')
    .start();
}

export async function startValkey(): Promise<StartedRedisContainer> {
  // The Redis module speaks RESP; Valkey is wire-compatible.
  return new RedisContainer(IMAGES.valkey).start();
}

export interface StartedMinio {
  readonly container: StartedTestContainer;
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

export async function startMinio(): Promise<StartedMinio> {
  const accessKey = 'hotella';
  const secretKey = 'hotella-test-secret';
  const container = await new GenericContainer(IMAGES.minio)
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    accessKey,
    secretKey,
  };
}
