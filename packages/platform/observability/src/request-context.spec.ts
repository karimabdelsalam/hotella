import 'reflect-metadata';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObservabilityModule } from './logger.module';
import { correlationIdFromHeader, RequestContext } from './request-context';

@Controller('ctx')
class CtxController {
  constructor(private readonly ctx: RequestContext) {}
  @Get()
  read(): Record<string, unknown> {
    this.ctx.setScope({ tenantId: 'tenant-1', actor: { type: 'USER', id: 'u1' } });
    return this.ctx.snapshot();
  }
}
@Module({ controllers: [CtxController] })
class CtxModule {}

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x',
  VALKEY_URL: 'redis://127.0.0.1:1',
};

describe('RequestContext', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ env }), ObservabilityModule.forRoot(), CtxModule],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('echoes a well-formed caller correlation id and exposes scope set during the request', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('X-Correlation-Id', 'abc-12345678')
      .expect(200);
    expect(res.headers['x-correlation-id']).toBe('abc-12345678');
    expect(res.body).toMatchObject({
      correlation_id: 'abc-12345678',
      tenant_id: 'tenant-1',
      actor_type: 'USER',
      actor_id: 'u1',
    });
  });

  it('mints an id when the header is missing or malformed', async () => {
    const res = await request(app.getHttpServer())
      .get('/ctx')
      .set('X-Correlation-Id', 'bad id with spaces')
      .expect(200);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFromHeader(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runs background work in a seeded context', async () => {
    const ctx = app.get(RequestContext);
    const seen = await ctx.run({ correlation_id: 'job-00000001', tenant_id: 't9' }, async () =>
      ctx.snapshot(),
    );
    expect(seen).toMatchObject({ correlation_id: 'job-00000001', tenant_id: 't9' });
    expect(ctx.correlationId).toBeNull(); // nothing leaks outside the run
  });
});
