import 'reflect-metadata';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import { Test } from '@nestjs/testing';
import { and, asc, eq, like } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { GuestModule, projectOnce, StayProjector } from '@hotella/domain-guest';
import {
  AgentGatewayModule,
  AgentGatewayServer,
  AgentKeys,
  ephemeralAgentKeys,
  INTEGRATIONS_API,
  integrationSchema,
  IntegrationsModule,
  type IntegrationsPublicApi,
} from '@hotella/domain-integrations';
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
  runMigrations,
} from '@hotella/platform-database';
import { EventsModule, eventsSchema, IdempotentConsumer } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';

/**
 * The platform side of the agent link for the e2e suites: the real agent gateway (mutual TLS, ephemeral CA) with
 * the integrations, organization and guest contexts, a tenant and property with rooms 504–506 and an ACTIVE agent
 * integration whose rooms are mapped by number. Each agent implementation (the TypeScript reference agent and the
 * .NET hotel agent) runs the same protocol against it.
 */

export const CAPABILITIES = [
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'ROOM_STATUS_READ',
  'RESERVATION_READ',
  'GUEST_READ',
  'RECONCILIATION_READ',
];

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

export async function until<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface GatewayHarness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly api: IntegrationsPublicApi;
  readonly gatewayUrl: string;
  readonly caPem: string;
  readonly tenant: string;
  readonly property: string;
  readonly instanceId: string;
  /** `/properties/:id` */
  readonly base: string;
  readonly http: () => ReturnType<typeof request>;
  /** The X-Test-Actor header of the property's GM. */
  readonly gm: string;
  /** The integration messages the gateway stored for this agent, in sequence order. */
  messages(): Promise<(typeof integrationSchema.integrationMessages.$inferSelect)[]>;
  /** Projects every canonical `hotel.*` event of the tenant like the worker does. */
  projectAll(): Promise<void>;
  /** A single-use enrollment token for the agent integration. */
  enrollmentToken(): Promise<string>;
}

function entitlementsModule(api: EntitlementPublicApi): DynamicModule {
  return {
    module: class FakeLicensingModule {},
    global: true,
    providers: [{ provide: ENTITLEMENT_API, useValue: api }],
    exports: [ENTITLEMENT_API],
  };
}

export async function startGatewayHarness(
  databaseUrl: string,
  code: string,
  integration: { connectorCode: string; capabilities: readonly string[] } = {
    connectorCode: 'SIM_PMS',
    capabilities: CAPABILITIES,
  },
  options: {
    /** Stands in for the licensing context (Spec §62: the agent licence follows the connector entitlement). */
    readonly entitlements?: EntitlementPublicApi;
  } = {},
): Promise<GatewayHarness> {
  await runMigrations(databaseUrl);
  const grants: Record<string, string[]> = {
    gm: [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'integration.read',
      'integration.configure',
      'integration.mapping.confirm',
      'integration.reconcile',
      'stay.read',
      'guest.read',
    ],
  };
  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: await applicationRoleUrl(databaseUrl, 'hotella_app_sim'),
    VALKEY_URL: 'redis://127.0.0.1:1',
    AGENT_HEARTBEAT_SECONDS: '5',
  };
  const ref = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ env }),
      ObservabilityModule.forRoot(),
      I18nModule.forRoot(),
      SecretsModule.forRoot(),
      HttpConventionsModule.forRoot({ store: 'memory' }),
      DatabaseModule.forRoot(),
      EventsModule.forRoot(),
      FeatureFlagsModule,
      ManifestModule.forRoot(),
      AuditModule,
      SettingsModule,
      AuthModule.forRoot({
        strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
        resolver: { provide: PERMISSION_RESOLVER, useValue: new StaticPermissionResolver(grants) },
        propertyVerifier: OrganizationModule.propertyVerifier(),
        stages: [IntegrationsModule.capabilityStage()],
      }),
      OrganizationModule,
      IntegrationsModule,
      GuestModule,
      AgentGatewayModule,
      ...(options.entitlements ? [entitlementsModule(options.entitlements)] : []),
    ],
  }).compile();
  const app = ref.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  const db = app.get<Database>(DATABASE);
  const keys = await ephemeralAgentKeys(['localhost']);
  app.get(AgentKeys).use(keys);
  const port = await app.get(AgentGatewayServer).listen({ host: '127.0.0.1', port: 0 });
  const http = () => request(app.getHttpServer());

  const tenant = (
    await http()
      .post('/tenants')
      .set('X-Test-Actor', admin)
      .send({ code, name: 'Sim Hotels' })
      .expect(201)
  ).body.id as string;
  const gm = user('gm', tenant);
  const property = (
    await http()
      .post('/properties')
      .set('X-Test-Actor', gm)
      .send({ code: 'SIM', name: 'Simulated', timezone: 'Africa/Cairo', currency: 'EGP' })
      .expect(201)
  ).body.id as string;
  const base = `/properties/${property}`;
  const tree = await http().get(`${base}/locations`).set('X-Test-Actor', gm).expect(200);
  const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
  for (const n of ['504', '505', '506'])
    await http()
      .post(`${base}/rooms`)
      .set('X-Test-Actor', gm)
      .send({ parentId: root, roomNumber: n })
      .expect(201);
  const instanceId = (
    await http()
      .post(`${base}/integrations`)
      .set('X-Test-Actor', gm)
      .send({ ...integration, name: 'Agent' })
      .expect(201)
  ).body.id as string;
  await http()
    .patch(`${base}/integrations/${instanceId}`)
    .set('X-Test-Actor', gm)
    .send({ version: 1, status: 'ACTIVE' })
    .expect(200);
  await http()
    .post(`${base}/integrations/${instanceId}/mappings/rooms-by-number`)
    .set('X-Test-Actor', gm)
    .expect(200);

  const project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));
  return {
    app,
    db,
    api: app.get(INTEGRATIONS_API),
    gatewayUrl: `https://localhost:${port}`,
    caPem: keys.caCertificatePem,
    tenant,
    property,
    instanceId,
    base,
    http,
    gm,
    messages: () =>
      db
        .select()
        .from(integrationSchema.integrationMessages)
        .where(eq(integrationSchema.integrationMessages.instanceId, instanceId))
        .orderBy(asc(integrationSchema.integrationMessages.sequenceNo)),
    projectAll: async () => {
      const rows = await db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, tenant),
            like(eventsSchema.outbox.eventType, 'hotel.%'),
          ),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
      for (const r of rows) await project(r.envelope as EventEnvelope);
    },
    enrollmentToken: async () =>
      (
        await http()
          .post(`${base}/integrations/${instanceId}/enrollment-tokens`)
          .set('X-Test-Actor', gm)
          .expect(201)
      ).body.token as string,
  };
}
