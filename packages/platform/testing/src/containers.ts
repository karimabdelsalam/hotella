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
  // SeaweedFS (Apache-2.0) is the S3 store; MinIO's community images were withdrawn in Sept 2026.
  s3: 'chrislusf/seaweedfs:4.48',
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

export interface StartedS3 {
  readonly container: StartedTestContainer;
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

/** Single-process SeaweedFS (master + volume + filer + S3 gateway) with one static identity. */
export async function startS3(): Promise<StartedS3> {
  const accessKey = 'hotella';
  const secretKey = 'hotella-test-secret';
  const s3Config = JSON.stringify({
    identities: [
      {
        name: 'test',
        credentials: [{ accessKey, secretKey }],
        actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'],
      },
    ],
  });
  const container = await new GenericContainer(IMAGES.s3)
    .withCommand([
      'server',
      '-dir=/data',
      '-ip.bind=0.0.0.0',
      '-master.volumeSizeLimitMB=64',
      '-s3',
      '-s3.port=8333',
      '-s3.config=/etc/seaweedfs/s3.json',
    ])
    .withCopyContentToContainer([{ content: s3Config, target: '/etc/seaweedfs/s3.json' }])
    .withExposedPorts(8333, 9333)
    .withWaitStrategy(Wait.forHttp('/cluster/healthz', 9333).forStatusCode(200))
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${container.getMappedPort(8333)}`,
    accessKey,
    secretKey,
  };
}
