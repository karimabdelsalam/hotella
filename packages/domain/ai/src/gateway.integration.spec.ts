import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { CatalogModule } from '@hotella/domain-catalog';
import { CommunicationsModule } from '@hotella/domain-communications';
import { GuestModule } from '@hotella/domain-guest';
import { IDENTITY_API } from '@hotella/domain-identity/public';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { OperationsModule } from '@hotella/domain-operations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import {
  AUTHENTICATION_STRATEGY,
  AuthModule,
  HeaderActorStrategy,
  PERMISSION_RESOLVER,
  StaticPermissionResolver,
} from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import {
  applicationRoleUrl,
  DATABASE,
  type Database,
  DatabaseModule,
  newId,
  runMigrations,
} from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagService, FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule, RequestContext } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiModule } from './ai.module';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import { ModelProviderError } from './application/providers/types';
import { killSwitch } from './domain/settings';
import { MODEL_GATEWAY, type ModelGatewayApi } from './public';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string) =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();

@Global()
@Module({
  providers: [
    {
      provide: IDENTITY_API,
      useValue: {
        getStaffMember: async () => null,
        usersWithPermission: async () => [],
        usersWithRole: async () => [],
        getStaffContact: async () => null,
      },
    },
  ],
  exports: [IDENTITY_API],
})
class FakeIdentityModule {}

describe.skipIf(needsInfra())(`Model Gateway against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const fake = new FakeModelProvider();
  const grants: Record<string, string[]> = {
    [gmId]: ['org.property.read', 'org.property.manage', 'ai.routing.manage', 'ai.usage.read'],
  };
  let app: INestApplication;
  let db: Database;
  let gateway: ModelGatewayApi;
  let tenantId: string;
  let propertyId: string;
  const models: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const gm = () => user(gmId, tenantId);
  const setting = (key: string, value: unknown, scope: 'PLATFORM' | 'TENANT') =>
    http()
      .put(`/config/values/${key}`)
      .set('X-Test-Actor', admin)
      .send({ scope, ...(scope === 'TENANT' ? { tenantId } : {}), value })
      .expect(200);
  const ask = (extra: Partial<Parameters<ModelGatewayApi['complete']>[0]> = {}) =>
    app.get(RequestContext).run({ correlation_id: `gw-${stamp}` }, () =>
      gateway.complete({
        tenantId,
        propertyId,
        capability: 'REASONING_HIGH',
        system: [
          { text: 'You are the concierge.', dataClass: 'PUBLIC' },
          { text: 'Passport number A1234567', dataClass: 'SENSITIVE' },
          { text: 'OTP seed 0xDEADBEEF', dataClass: 'RESTRICTED' },
        ],
        messages: [
          {
            role: 'user',
            content: 'Call me on +20 100 111 2233, room 504',
            dataClass: 'CONFIDENTIAL',
          },
        ],
        ...extra,
      }),
    );
  const systemOf = (i: number) =>
    fake.requests[i]!.request.messages.filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
  const userOf = (i: number) =>
    fake.requests[i]!.request.messages.find((m) => m.role === 'user')!.content;

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_ai'),
      VALKEY_URL: 'redis://127.0.0.1:1',
      PUBLIC_BASE_URL: 'https://guest.example.test',
    };
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        SecretsModule.forRoot({
          providers: [
            new EnvSecretProvider({ CLOUD_KEY: 'k', COMMS_OTP_HMAC_KEY: 'test-otp-key' }),
          ],
        }),
        HttpConventionsModule.forRoot({ store: 'memory' }),
        DatabaseModule.forRoot(),
        EventsModule.forRoot(),
        FeatureFlagsModule,
        ManifestModule.forRoot(),
        AuditModule,
        SettingsModule,
        AuthModule.forRoot({
          strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
          resolver: {
            provide: PERMISSION_RESOLVER,
            useValue: new StaticPermissionResolver(grants),
          },
          propertyVerifier: OrganizationModule.propertyVerifier(),
          stages: [IntegrationsModule.capabilityStage(), ...AiModule.gateStages()],
        }),
        OrganizationModule,
        IntegrationsModule,
        GuestModule,
        FakeIdentityModule,
        OperationsModule,
        CommunicationsModule,
        CatalogModule,
        AiModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    gateway = app.get(MODEL_GATEWAY);
    app.get(ModelProviderRegistry).register(fake);
    tenantId = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `ai-${stamp}`, name: 'A' })
        .expect(201)
    ).body.id;
    propertyId = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({ code: 'AIP', name: 'AI Hotel', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id;
    const provider = async (code: string, egress: string, maxDataClass: string) =>
      (
        await http()
          .post('/ai/providers')
          .set('X-Test-Actor', admin)
          .send({
            code: `${code}_${stamp}`,
            kind: 'FAKE',
            egress,
            maxDataClass,
            credentialRef: 'env://CLOUD_KEY',
          })
          .expect(201)
      ).body.id as string;
    const onPrem = await provider('ONPREM', 'ON_PREM', 'SENSITIVE');
    const cloud = await provider('CLOUD', 'EXTERNAL', 'CONFIDENTIAL');
    // RESTRICTED is never a valid maximum.
    await http()
      .post('/ai/providers')
      .set('X-Test-Actor', admin)
      .send({ code: `BAD_${stamp}`, kind: 'FAKE', egress: 'ON_PREM', maxDataClass: 'RESTRICTED' })
      .expect(400);
    for (const [name, providerId, caps, price] of [
      ['local', onPrem, ['REASONING_HIGH', 'EMBEDDING'], 0],
      ['cloud', cloud, ['REASONING_HIGH'], 300_000],
    ] as const)
      models[name] = (
        await http()
          .post('/ai/models')
          .set('X-Test-Actor', admin)
          .send({
            providerId,
            code: `${name}-${stamp}`,
            capabilities: caps,
            inputPerMillionMinor: price,
            outputPerMillionMinor: price,
          })
          .expect(201)
      ).body.id;
    await http()
      .put('/ai/routing-rules/platform')
      .set('X-Test-Actor', gm())
      .send({ capability: 'REASONING_HIGH', modelIds: [models.cloud] })
      .expect(403);
    await http()
      .put('/ai/routing-rules/platform')
      .set('X-Test-Actor', admin)
      .send({ capability: 'REASONING_HIGH', modelIds: [models.cloud, models.local] })
      .expect(200);
    await http()
      .put('/ai/routing-rules/platform')
      .set('X-Test-Actor', admin)
      .send({ capability: 'EMBEDDING', modelIds: [models.cloud] })
      .expect(422);
    await http()
      .put('/ai/routing-rules/platform')
      .set('X-Test-Actor', admin)
      .send({ capability: 'EMBEDDING', modelIds: [models.local] })
      .expect(200);
  });
  afterAll(() => app?.close());
  beforeEach(() => fake.reset());

  it('without the owner’s opt-in, external providers are skipped; on-prem gets up to its class, never RESTRICTED', async () => {
    const out = await ask();
    expect(out).toMatchObject({ model: `local-${stamp}`, fallbackFrom: null, costMinor: 0 });
    expect(fake.requests).toHaveLength(1);
    expect(systemOf(0)).toContain('Passport number A1234567');
    expect(systemOf(0)).not.toContain('DEADBEEF');
    // On-prem: identifiers stay as they are.
    expect(userOf(0)).toContain('+20 100 111 2233');
  });

  it('with the opt-in and a budget, the external provider is used and gets masked, class-limited content', async () => {
    await setting('ai.external_providers.allowed', [`CLOUD_${stamp}`], 'PLATFORM');
    await setting('ai.external_providers.enabled', true, 'TENANT');
    await setting('ai.budget.monthly_limit_minor', 1000, 'TENANT');
    const out = await ask();
    expect(out.model).toBe(`cloud-${stamp}`);
    expect(systemOf(0)).not.toContain('Passport');
    expect(userOf(0)).toBe('Call me on [phone], room 504');
    const [call] = (
      await db.execute(sql`select egress, dropped_parts, cost_minor, correlation_id, outcome from ai.model_calls
        where id = ${out.modelCallId}`)
    ).rows as Array<Record<string, unknown>>;
    expect(call).toEqual({
      egress: 'EXTERNAL',
      dropped_parts: 2,
      cost_minor: 36,
      correlation_id: `gw-${stamp}`,
      outcome: 'OK',
    });
  });

  it('falls back on retryable failures and records both attempts; kill switches skip a provider', async () => {
    fake.failWith = new ModelProviderError('UNAVAILABLE', true);
    fake.failFor = `CLOUD_${stamp}`;
    const out = await ask();
    expect(out).toMatchObject({ model: `local-${stamp}`, fallbackFrom: `cloud-${stamp}` });
    const outcomes = (
      await db.execute(sql`select model_code, outcome from ai.model_calls where tenant_id = ${tenantId}
        order by created_at desc, id desc limit 2`)
    ).rows as Array<{ model_code: string; outcome: string }>;
    expect(outcomes.map((o) => o.outcome)).toEqual(['OK', 'UNAVAILABLE']);

    fake.reset();
    await app.get(FeatureFlagService).set({
      key: killSwitch.provider(`CLOUD_${stamp}`),
      scope: 'TENANT',
      scopeId: tenantId,
      enabled: true,
    });
    expect((await ask()).model).toBe(`local-${stamp}`);
    expect(fake.requests.map((r) => r.providerCode)).toEqual([`ONPREM_${stamp}`]);
    await app.get(FeatureFlagService).set({
      key: killSwitch.provider(`CLOUD_${stamp}`),
      scope: 'TENANT',
      scopeId: tenantId,
      enabled: false,
    });
  });

  it('stops external spend at the monthly budget and raises one alert', async () => {
    await setting('ai.budget.monthly_limit_minor', 40, 'TENANT');
    await ask(); // spends up to the limit on the cloud model
    await ask();
    expect((await ask()).model).toBe(`local-${stamp}`);
    const alerts = (
      await db.execute(sql`select count(*)::int as n from ops.alerts where tenant_id = ${tenantId}
        and type = 'AI_BUDGET_EXHAUSTED'`)
    ).rows as Array<{ n: number }>;
    expect(alerts[0]!.n).toBe(1);
    // The budget is per hotel: another hotel of the same company still has its own.
    const second = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({ code: 'AIP2', name: 'AI Hotel 2', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id as string;
    expect((await ask({ propertyId: second })).model).toBe(`cloud-${stamp}`);
  });

  it('a tenant routes a capability to its own choice; no route means unavailable; usage is reported', async () => {
    await http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'REASONING_HIGH', modelIds: [models.local], propertyId })
      .expect(200);
    expect((await ask()).model).toBe(`local-${stamp}`);
    await expect(ask({ capability: 'VISION' })).rejects.toMatchObject({
      code: 'ai.gateway.unavailable',
    });
    const emb = await gateway.embed({ tenantId, texts: [{ text: 'towels', dataClass: 'PUBLIC' }] });
    expect(emb.vectors[0]).toHaveLength(64);
    const usage = await http().get('/ai/usage').set('X-Test-Actor', gm()).expect(200);
    const capabilities = (usage.body.rows as Array<{ capability: string }>).map(
      (r) => r.capability,
    );
    expect(capabilities).toEqual(expect.arrayContaining(['REASONING_HIGH', 'EMBEDDING']));
    // Another tenant's staff see nothing of this tenant's usage or rules.
    const other = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `ai-b-${stamp}`, name: 'B' })
        .expect(201)
    ).body.id;
    grants[`${gmId}-b`] = ['ai.usage.read', 'ai.routing.manage'];
    const theirs = await http()
      .get('/ai/usage')
      .set('X-Test-Actor', user(`${gmId}-b`, other))
      .expect(200);
    expect(theirs.body.rows).toEqual([]);
    const rules = await http()
      .get('/ai/routing-rules')
      .set('X-Test-Actor', user(`${gmId}-b`, other))
      .expect(200);
    expect(rules.body).toEqual([]);
  });

  it('a photo goes only with VISION, only to a provider allowed SENSITIVE data, and as an image part (9.5)', async () => {
    const photo = {
      mediaType: 'image/jpeg' as const,
      data: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
      dataClass: 'SENSITIVE' as const,
    };
    const look = (capability: 'VISION' | 'REASONING_HIGH') =>
      gateway.complete({
        tenantId,
        propertyId,
        capability,
        system: [{ text: 'Describe the object in the photo.', dataClass: 'INTERNAL' }],
        messages: [
          { role: 'user', content: 'What is it?', dataClass: 'INTERNAL', images: [photo] },
        ],
      });
    await expect(look('REASONING_HIGH')).rejects.toMatchObject({
      code: 'ai.gateway.images_need_vision',
    });

    const visionModel = async (code: string, egress: string, maxDataClass: string) => {
      const providerId = (
        await http()
          .post('/ai/providers')
          .set('X-Test-Actor', admin)
          .send({ code: `${code}_${stamp}`, kind: 'FAKE', egress, maxDataClass })
          .expect(201)
      ).body.id as string;
      return (
        await http()
          .post('/ai/models')
          .set('X-Test-Actor', admin)
          .send({ providerId, code: `${code.toLowerCase()}-v-${stamp}`, capabilities: ['VISION'] })
          .expect(201)
      ).body.id as string;
    };
    const cloudVision = await visionModel('VCLOUD', 'EXTERNAL', 'CONFIDENTIAL');
    const localVision = await visionModel('VLOCAL', 'ON_PREM', 'SENSITIVE');
    await setting(
      'ai.external_providers.allowed',
      [`CLOUD_${stamp}`, `VCLOUD_${stamp}`],
      'PLATFORM',
    );
    await setting('ai.external_providers.enabled', true, 'TENANT');
    await setting('ai.budget.monthly_limit_minor', 100_000_000, 'TENANT');

    // The only routed provider may not receive SENSITIVE data: nothing leaves the platform. (The hotel's own rule:
    // a platform-wide one would outlive this run in a shared test database.)
    await http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'VISION', modelIds: [cloudVision], propertyId })
      .expect(200);
    await expect(look('VISION')).rejects.toMatchObject({
      code: 'ai.gateway.unavailable',
      params: { reason: 'EGRESS_POLICY' },
    });
    expect(fake.requests).toHaveLength(0);

    // With an on-prem model allowed SENSITIVE behind it, that one reads the photo.
    await http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'VISION', modelIds: [cloudVision, localVision], propertyId })
      .expect(200);
    const out = await look('VISION');
    expect(out.model).toBe(`vlocal-v-${stamp}`);
    expect(fake.requests.map((r) => r.providerCode)).toEqual([`VLOCAL_${stamp}`]);
    expect(fake.requests[0]!.request.messages.find((m) => m.role === 'user')).toEqual({
      role: 'user',
      content: 'What is it?',
      images: [{ mediaType: 'image/jpeg', base64: Buffer.from(photo.data).toString('base64') }],
    });
  });
});
