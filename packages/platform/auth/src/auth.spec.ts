import 'reflect-metadata';
import { Controller, Get, Global, type INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@hotella/platform-config';
import { FeatureFlagService } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ObservabilityModule } from '@hotella/platform-observability';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionGate } from './action-gate';
import { ActorStore } from './actor';
import { AuthModule } from './auth.module';
import { AUTHENTICATION_STRATEGY, PERMISSION_RESOLVER } from './contracts';
import { PropertyScoped, Public, RequirePermission, TenantScoped } from './decorators';
import { HeaderActorStrategy, StaticPermissionResolver } from './testing';

const P1 = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f01';
const P2 = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f02';
const T1 = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f10';
const T2 = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f20';

@Controller('t')
class TController {
  constructor(
    private readonly actors: ActorStore,
    private readonly gate: ActionGate,
  ) {}
  @Public() @Get('public') pub(): { ok: true } {
    return { ok: true };
  }
  @Get('me') me(): unknown {
    return this.actors.get();
  }
  @Get('properties/:propertyId/tasks')
  @PropertyScoped({ from: 'param' })
  @RequirePermission('task.read')
  tasks(): { ok: true } {
    return { ok: true };
  }
  @Get('tenants/:tenantId')
  @TenantScoped({ from: 'param' })
  @RequirePermission('org.tenant.manage')
  tenant(): { ok: true } {
    return { ok: true };
  }
  @Post('gate') async gated(): Promise<{ ok: true }> {
    return this.gate.execute(
      { action: 'org.property.manage', tenantId: T1, propertyId: P1, feature: 'test.flag' },
      async () => ({ ok: true }),
    );
  }
}
@Module({ controllers: [TController] })
class TModule {}

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x',
  VALKEY_URL: 'redis://127.0.0.1:1',
};
const actor = (over: Record<string, unknown>): string =>
  JSON.stringify({ type: 'USER', id: 'u1', tenantId: T1, ...over });

const flags = {
  isEnabled: async (key: string) => key !== 'test.flag.off',
} as unknown as FeatureFlagService;

/** Stands in for FeatureFlagsModule (which needs a database). */
@Global()
@Module({
  providers: [{ provide: FeatureFlagService, useValue: flags }],
  exports: [FeatureFlagService],
})
class FlagsStubModule {}

describe('AuthGuard + ActionGate', () => {
  let app!: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        FlagsStubModule,
        AuthModule.forRoot({
          strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
          resolver: {
            provide: PERMISSION_RESOLVER,
            useValue: new StaticPermissionResolver({
              u1: [`task.read@${P1}`, 'org.property.manage'],
              u2: ['*'],
            }),
          },
        }),
        TModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(() => app?.close());

  it('public routes need no actor; protected routes return 401 without one', async () => {
    await request(app.getHttpServer()).get('/t/public').expect(200);
    const res = await request(app.getHttpServer()).get('/t/me').expect(401);
    expect(res.body.code).toBe('platform.unauthorized');
  });

  it('property-scoped permission is granted for P1 and denied (403) for P2', async () => {
    await request(app.getHttpServer())
      .get(`/t/properties/${P1}/tasks`)
      .set('X-Test-Actor', actor({}))
      .expect(200);
    const res = await request(app.getHttpServer())
      .get(`/t/properties/${P2}/tasks`)
      .set('X-Test-Actor', actor({}))
      .expect(403);
    expect(res.body).toMatchObject({
      code: 'platform.forbidden',
      params: { permission: 'task.read' },
    });
    await request(app.getHttpServer())
      .get(`/t/properties/${P2}/tasks`)
      .set('X-Test-Actor', actor({ id: 'u2' }))
      .expect(200);
  });

  it('a tenant user naming another tenant gets 404, a platform admin may name any tenant', async () => {
    await request(app.getHttpServer())
      .get(`/t/tenants/${T2}`)
      .set('X-Test-Actor', actor({ id: 'u2' }))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/t/tenants/${T2}`)
      .set('X-Test-Actor', actor({ id: 'admin', tenantId: null, isPlatformAdmin: true }))
      .expect(200);
    await request(app.getHttpServer())
      .get('/t/tenants/not-a-uuid')
      .set('X-Test-Actor', actor({ id: 'u2' }))
      .expect(400);
  });

  it('ActionGate authorizes the action and consults feature flags', async () => {
    await request(app.getHttpServer()).post('/t/gate').set('X-Test-Actor', actor({})).expect(201);
    const denied = await request(app.getHttpServer())
      .post('/t/gate')
      .set('X-Test-Actor', actor({ id: 'nobody' }))
      .expect(403);
    expect(denied.body.params.permission).toBe('org.property.manage');
  });
});
