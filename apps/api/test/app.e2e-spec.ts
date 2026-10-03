import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import { LoggerModule } from '@hotella/platform-observability';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from '../src/bootstrap';
import { HealthModule } from '../src/health/health.module';
import { MetaModule } from '../src/meta/meta.module';

const testEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  // Unreachable on purpose: readiness must report 503 with per-dependency details, not crash.
  DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x',
  VALKEY_URL: 'redis://127.0.0.1:1',
};

describe('api skeleton (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env: testEnv }),
        LoggerModule.forRoot(),
        HealthModule,
        MetaModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health → 200 liveness', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200).expect({ status: 'ok' });
  });

  it('GET /api/v1/ready → 503 with per-dependency details when infra is down', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/ready').expect(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 503, code: 'platform.not_ready' });
    expect(res.body.details.postgres.status).toBe('down');
    expect(res.body.details.valkey.status).toBe('down');
  });

  it('POST /api/v1/meta/echo validates with zod and returns the body', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/echo')
      .send({ message: 'مرحبا', locale: 'ar' })
      .expect(201);
    expect(res.body).toEqual({ echoed: 'مرحبا', locale: 'ar' });
  });

  it('invalid body → RFC 9457 Problem Details 400 with field errors', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/echo')
      .set('X-Correlation-Id', 'test-corr-1')
      .send({ message: '', locale: 'fr' })
      .expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      status: 400,
      code: 'platform.validation_failed',
      correlation_id: 'test-corr-1',
    });
    const paths = (res.body.errors as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['message', 'locale']));
  });

  it('unknown route → Problem Details 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.body).toMatchObject({ status: 404, code: 'platform.http_404' });
  });
});
