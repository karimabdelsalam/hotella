import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  type INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import { I18nModule } from '@hotella/platform-i18n';
import { ObservabilityModule } from '@hotella/platform-observability';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConventionsModule } from './http.module';
import { KV_STORE, type KeyValueStore } from './kv-store';
import { RateLimit } from './rate-limit.guard';

let counter = 0;
@Controller('things')
class ThingsController {
  @Post()
  create(@Body() body: { name: string }): { id: number; name: string } {
    counter++;
    return { id: counter, name: body.name };
  }
  @Get('limited')
  @RateLimit({ name: 'test-limited', limit: 2, windowSeconds: 60, keyBy: 'ip' })
  limited(): { ok: true } {
    return { ok: true };
  }
  @Post('fail')
  @HttpCode(500)
  fail(): never {
    throw new Error('boom');
  }
}
@Module({ controllers: [ThingsController] })
class ThingsModule {}

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x',
  VALKEY_URL: 'redis://127.0.0.1:1',
};

describe('HTTP conventions (memory store)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        ThingsModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('replays the stored response for the same Idempotency-Key and body', async () => {
    const key = 'order-0001-abcdef';
    const first = await request(app.getHttpServer())
      .post('/things')
      .set('Idempotency-Key', key)
      .send({ name: 'towels' })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/things')
      .set('Idempotency-Key', key)
      .send({ name: 'towels' })
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
  });

  it('rejects the same key with a different body (422) and malformed keys (400)', async () => {
    const key = 'order-0002-abcdef';
    await request(app.getHttpServer())
      .post('/things')
      .set('Idempotency-Key', key)
      .send({ name: 'a' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/things')
      .set('Idempotency-Key', key)
      .send({ name: 'b' })
      .expect(422);
    expect(res.body.code).toBe('platform.idempotency_key_reused');
    const bad = await request(app.getHttpServer())
      .post('/things')
      .set('Idempotency-Key', 'x')
      .send({ name: 'a' })
      .expect(400);
    expect(bad.body.code).toBe('platform.idempotency_key_invalid');
  });

  it('does not store failed attempts, so a retry with the same key executes', async () => {
    const key = 'order-0003-abcdef';
    await request(app.getHttpServer())
      .post('/things/fail')
      .set('Idempotency-Key', key)
      .send({})
      .expect(500);
    await request(app.getHttpServer())
      .post('/things/fail')
      .set('Idempotency-Key', key)
      .send({})
      .expect(500);
  });

  it('rate limits per policy with IETF headers and a localized 429', async () => {
    await request(app.getHttpServer()).get('/things/limited').expect(200);
    const second = await request(app.getHttpServer()).get('/things/limited').expect(200);
    expect(second.headers['ratelimit-limit']).toBe('2');
    expect(second.headers['ratelimit-remaining']).toBe('0');
    const third = await request(app.getHttpServer())
      .get('/things/limited')
      .set('Accept-Language', 'ar')
      .expect(429);
    expect(third.headers['retry-after']).toMatch(/^\d+$/);
    expect(third.body.code).toBe('platform.rate_limited');
    expect(third.body.detail).toMatch(/طلبات كثيرة جدًا/);
  });

  it('renders unknown errors as a generic 500 Problem Details without leaking the message', async () => {
    const res = await request(app.getHttpServer()).post('/things/fail').send({}).expect(500);
    expect(res.body.code).toBe('platform.internal_error');
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});

/** A limiter/idempotency store that is down (Valkey outage). */
const downStore: KeyValueStore = {
  get: () => Promise.reject(new Error('Connection is closed.')),
  setIfAbsent: () => Promise.reject(new Error('Connection is closed.')),
  set: () => Promise.reject(new Error('Connection is closed.')),
  incrementWindow: () => Promise.reject(new Error('Connection is closed.')),
  delete: () => Promise.reject(new Error('Connection is closed.')),
};

describe('HTTP conventions when the store is unavailable', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        ThingsModule,
      ],
    })
      .overrideProvider(KV_STORE)
      .useValue(downStore)
      .compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('rate limiting fails open instead of hanging or failing the request', async () => {
    for (let i = 0; i < 4; i++)
      await request(app.getHttpServer()).get('/things/limited').expect(200);
  });

  it('requests with an Idempotency-Key get a retryable 503; requests without one proceed', async () => {
    const res = await request(app.getHttpServer())
      .post('/things')
      .set('Idempotency-Key', 'order-0099-abcdef')
      .send({ name: 'soap' })
      .expect(503);
    expect(res.body).toMatchObject({ status: 503, code: 'platform.dependency_unavailable' });
    await request(app.getHttpServer()).post('/things').send({ name: 'soap' }).expect(201);
  });
});
