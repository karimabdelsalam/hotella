import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  IdentityCoreModule,
  IdentityModule,
  identityAuthOptions,
  identityLocalePreferences,
} from '@hotella/domain-identity';
import { GuestModule } from '@hotella/domain-guest';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { AiModule } from '@hotella/domain-ai';
import { CatalogModule } from '@hotella/domain-catalog';
import { CommunicationsModule } from '@hotella/domain-communications';
import { OperationsModule } from '@hotella/domain-operations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import { SettingsModule } from '@hotella/platform-settings';
import { AuthModule } from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule } from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { ManifestModule } from '@hotella/platform-manifest';
import { I18nModule } from '@hotella/platform-i18n';
import { ObservabilityModule } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { QueueModule } from '@hotella/platform-queue';
import { StorageModule } from '@hotella/platform-storage';
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
  let openApi: OpenAPIObject | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env: testEnv }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot({ preferences: identityLocalePreferences() }),
        SecretsModule.forRoot({
          providers: [
            new EnvSecretProvider({ STORAGE_ACCESS_KEY: 'test', STORAGE_SECRET_KEY: 'test' }),
          ],
        }),
        DatabaseModule.forRoot(),
        QueueModule.forRoot(),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        EventsModule.forRoot(),
        FeatureFlagsModule,
        ManifestModule.forRoot(),
        AuditModule,
        SettingsModule,
        StorageModule.forRoot(),
        IdentityCoreModule,
        AuthModule.forRoot({
          ...identityAuthOptions(),
          propertyVerifier: OrganizationModule.propertyVerifier(),
          stages: [IntegrationsModule.capabilityStage()],
        }),
        OrganizationModule,
        IdentityModule,
        IntegrationsModule,
        GuestModule,
        OperationsModule,
        CommunicationsModule,
        CatalogModule,
        AiModule,
        HealthModule,
        MetaModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    openApi = configureApp(app, { openApi: true });
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

  it('every response carries X-Correlation-Id (echoed when well-formed)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('X-Correlation-Id', 'corr-abcdef12')
      .expect(200);
    expect(res.headers['x-correlation-id']).toBe('corr-abcdef12');
    const minted = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(minted.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('serves the OpenAPI document generated from zod DTOs and it matches the snapshot', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs/json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/health',
        '/api/v1/ready',
        '/api/v1/meta/echo',
        '/api/v1/tenants',
        '/api/v1/properties/{propertyId}/locations',
        '/api/v1/public/branding',
      ]),
    );
    expect(
      res.body.paths['/api/v1/meta/echo'].post.requestBody.content['application/json'].schema,
    ).toBeDefined();
    expect(openApi).toBeDefined();
    await expect(JSON.stringify(openApi, null, 2)).toMatchFileSnapshot(
      './__snapshots__/openapi.json',
    );
  });

  it('exposes validated module manifests', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/meta/manifests').expect(200);
    const byCode = new Map(
      (res.body as { code: string; events: string[] }[]).map((m) => [m.code, m]),
    );
    expect([...byCode.keys()].sort()).toEqual([
      'ai',
      'audit',
      'catalog',
      'comms',
      'guest',
      'iam',
      'integration',
      'ops',
      'org',
      'platform',
    ]);
    expect(byCode.get('integration')?.events).toContain('hotel.guest.checked_in.v1');
    expect(byCode.get('iam')?.events).toContain('iam.session.revoked.v1');
    expect(byCode.get('platform')?.events).toContain('platform.feature_flag.changed.v1');
    expect(byCode.get('org')?.events).toContain('org.property.created.v1');
  });

  it('protected organization routes reject anonymous callers with a localized 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/properties')
      .set('Accept-Language', 'ar')
      .expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 401, code: 'platform.unauthorized' });
    await request(app.getHttpServer()).post('/api/v1/tenants').send({}).expect(401);
    // a forged or malformed bearer token is the same as none
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.')
      .expect(401);
  });

  it('unknown route → Problem Details 404, localized detail from the request locale', async () => {
    const en = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(en.body).toMatchObject({
      status: 404,
      code: 'platform.http_404',
      detail: 'The requested resource was not found.',
    });
    const ar = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('Accept-Language', 'ar')
      .expect(404);
    expect(ar.body.detail).toBe('المورد المطلوب غير موجود.');
    expect(ar.headers['content-language']).toBe('ar');
  });

  it('validation detail is an ICU plural in Arabic with exposed params', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/echo?lang=ar')
      .send({ message: '', locale: 'fr' })
      .expect(400);
    expect(res.body.detail).toBe('يوجد حقلان غير صالحين.');
    expect(res.body.params).toEqual({ count: 2 });
  });

  it('AppError renders its code with localized detail (meta/fail)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/meta/fail')
      .set('Accept-Language', 'ar')
      .expect(409);
    expect(res.body).toMatchObject({
      status: 409,
      code: 'platform.conflict',
      detail: 'يتعارض هذا التغيير مع الحالة الحالية. حدّث الصفحة وحاول مرة أخرى.',
    });
  });
});
