import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import type { EventEnvelope } from '@hotella/contracts-events';
import {
  GuestModule,
  projectOnce,
  reconcileOnce,
  StayProjector,
  StayReconciler,
} from '@hotella/domain-guest';
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
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentIdentity,
  AgentLinkClient,
  DurableQueue,
  enroll,
  type HttpError,
  loadScenario,
  runScenario,
  SimulatedPms,
} from '../src';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const CAPABILITIES = [
  'CHECKIN_EVENT',
  'CHECKOUT_EVENT',
  'ROOM_MOVE_EVENT',
  'PROFILE_EVENT',
  'ROOM_STATUS_READ',
  'RESERVATION_READ',
  'GUEST_READ',
  'RECONCILIATION_READ',
];

async function until<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(needsInfra())(
  `hotel agent link: simulator ↔ gateway over mutual TLS (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let app: INestApplication;
    let db: Database;
    let api: IntegrationsPublicApi;
    let gatewayUrl: string;
    let caPem: string;
    let tenant: string;
    let property: string;
    let instanceId: string;
    let identity: AgentIdentity;
    let client: AgentLinkClient;
    let pms: SimulatedPms;
    const queue = DurableQueue.memory();
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
    const http = () => request(app.getHttpServer());
    const gm = () => user('gm', tenant);
    const base = () => `/properties/${property}`;

    const messages = () =>
      db
        .select()
        .from(integrationSchema.integrationMessages)
        .where(eq(integrationSchema.integrationMessages.instanceId, instanceId));

    beforeAll(async () => {
      await runMigrations(url);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_sim'),
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
            resolver: {
              provide: PERMISSION_RESOLVER,
              useValue: new StaticPermissionResolver(grants),
            },
            propertyVerifier: OrganizationModule.propertyVerifier(),
            stages: [IntegrationsModule.capabilityStage()],
          }),
          OrganizationModule,
          IntegrationsModule,
          GuestModule,
          AgentGatewayModule,
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
      db = app.get(DATABASE);
      api = app.get(INTEGRATIONS_API);
      const keys = await ephemeralAgentKeys(['localhost']);
      caPem = keys.caCertificatePem;
      app.get(AgentKeys).use(keys);
      const port = await app.get(AgentGatewayServer).listen({ host: '127.0.0.1', port: 0 });
      gatewayUrl = `https://localhost:${port}`;

      tenant = (
        await http()
          .post('/tenants')
          .set('X-Test-Actor', admin)
          .send({ code: `sim-${stamp}`, name: 'Sim Hotels' })
          .expect(201)
      ).body.id;
      property = (
        await http()
          .post('/properties')
          .set('X-Test-Actor', gm())
          .send({ code: 'SIM', name: 'Simulated', timezone: 'Africa/Cairo', currency: 'EGP' })
          .expect(201)
      ).body.id;
      const tree = await http().get(`${base()}/locations`).set('X-Test-Actor', gm()).expect(200);
      const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
      for (const n of ['504', '505', '506'])
        await http()
          .post(`${base()}/rooms`)
          .set('X-Test-Actor', gm())
          .send({ parentId: root, roomNumber: n })
          .expect(201);
      instanceId = (
        await http()
          .post(`${base()}/integrations`)
          .set('X-Test-Actor', gm())
          .send({ connectorCode: 'SIM_PMS', name: 'Agent', capabilities: CAPABILITIES })
          .expect(201)
      ).body.id;
      await http()
        .patch(`${base()}/integrations/${instanceId}`)
        .set('X-Test-Actor', gm())
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      await http()
        .post(`${base()}/integrations/${instanceId}/mappings/rooms-by-number`)
        .set('X-Test-Actor', gm())
        .expect(200);
    });
    afterAll(async () => {
      client?.stop();
      await app?.close();
    });

    it('enrolls once with a single-use token and gets a device certificate', async () => {
      const token = (
        await http()
          .post(`${base()}/integrations/${instanceId}/enrollment-tokens`)
          .set('X-Test-Actor', gm())
          .expect(201)
      ).body.token as string;
      identity = await enroll({ gatewayUrl, token, caCertificatePem: caPem, agentVersion: 'test' });
      expect(identity.instanceId).toBe(instanceId);
      await expect(
        enroll({ gatewayUrl, token, caCertificatePem: caPem, agentVersion: 'test' }),
      ).rejects.toMatchObject({ status: 401, code: 'integration.agent.enrollment_invalid' });
      const status = await http()
        .get(`${base()}/integrations/${instanceId}/agent`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(status.body).toMatchObject({ enrolled: true, connected: false });
    });

    it('rejects a link without a client certificate', async () => {
      const ws = new WebSocket(`${gatewayUrl.replace('https', 'wss')}/agent/v1/link`, {
        ca: caPem,
      });
      const status = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(-1));
      });
      expect(status).toBe(401);
    });

    it('connects, reports capabilities and delivers a scenario exactly once despite chaos', async () => {
      client = new AgentLinkClient({
        gatewayUrl,
        identity,
        queue,
        connectorCode: 'SIM_PMS',
        capabilities: CAPABILITIES.filter((c) => c !== 'GUEST_READ'),
        agentVersion: 'test',
        onCommand: async (cmd) =>
          cmd.command_type === 'RESYNC_IN_HOUSE'
            ? (pms.resyncInHouse(), { status: 'ACKNOWLEDGED' as const })
            : { status: 'FAILED' as const, error: 'unsupported' },
      });
      const scenario = loadScenario(join(process.cwd(), 'scenarios', 'basic-stay.yml'));
      pms = new SimulatedPms({
        timezone: scenario.timezone,
        faces: new Set(scenario.faces),
        emit: (m) => client.publish(m),
      });
      client.start();
      await until(async () => client.connected);
      const instance = await http()
        .get(`${base()}/integrations/${instanceId}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      // Enabled ∩ reported: the agent did not report GUEST_READ, so it is not effective.
      expect(instance.body.effectiveCapabilities).not.toContain('GUEST_READ');
      expect(instance.body.effectiveCapabilities).toContain('CHECKIN_EVENT');

      await runScenario(scenario, pms, client);
      expect(client.stats.resends).toBeGreaterThanOrEqual(1);
      expect(client.stats.connects).toBeGreaterThanOrEqual(2);

      const rows = await messages();
      const sequences = rows.map((m) => m.sequenceNo).sort((a, b) => a! - b!);
      expect(new Set(sequences).size).toBe(rows.length);
      expect(sequences).toEqual(sequences.map((_, i) => i + 1));
      // The OWS profile message needs GUEST_READ, which this hotel's agent does not serve.
      expect(rows.filter((m) => m.status !== 'PROCESSED').map((m) => m.messageType)).toEqual(
        rows.filter((m) => m.messageType === 'OWS_PROFILE').map(() => 'OWS_PROFILE'),
      );

      // Project the canonical events like the worker does, then read the stay.
      const project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));
      const outbox = await db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, tenant),
            like(eventsSchema.outbox.eventType, 'hotel.%'),
          ),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
      for (const r of outbox) await project(r.envelope as EventEnvelope);
      const stays = await http().get(`${base()}/stays`).set('X-Test-Actor', gm()).expect(200);
      expect(stays.body).toHaveLength(1);
      const stay = await http()
        .get(`${base()}/stays/${stays.body[0].id}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(stay.body.status).toBe('CHECKED_OUT');
      expect(
        stay.body.roomAssignments.map((a: { roomNumber: string; reason: string }) => [
          a.roomNumber,
          a.reason,
        ]),
      ).toEqual([
        ['504', 'PRE_ASSIGNMENT'],
        ['505', 'INITIAL'],
        ['506', 'ROOM_MOVE'],
      ]);
      expect(
        stay.body.party.find((m: { role: string }) => m.role === 'PRIMARY').guest.primaryLocale,
      ).toBe('en');

      // A message held back for the reorder chaos is not stranded when nothing follows it (pilot defect).
      client.chaos.reorderNext = true;
      pms.roomStatus('504', 1, '2026-10-06T09:00:00Z');
      await client.drained(5_000);
    });

    it('heartbeats report liveness and backlog; rejected messages degrade health', async () => {
      const health = await until(async () => {
        const h = await http()
          .get(`${base()}/integrations/${instanceId}`)
          .set('X-Test-Actor', gm())
          .expect(200);
        // The hello marks the agent seen; the first heartbeat (every 5 s here) adds its backlog.
        return h.body.health?.queueDepth !== null ? h.body.health : undefined;
      });
      // Alive, but the rejected OWS profile message (capability not served by this agent) counts as an error.
      expect(health.queueDepth).toBe(0);
      expect(health.errorRatePermille).toBeGreaterThan(0);
      expect(health.status).toBe('DEGRADED');
    });

    it('delivers signed commands and records the agent result', async () => {
      const command = await api.requestCommand({
        tenantId: tenant,
        integrationInstanceId: instanceId,
        commandType: 'RESYNC_IN_HOUSE',
        payload: {},
        idempotencyKey: `resync-${stamp}`,
        requestedBy: { type: 'SYSTEM', id: null },
      });
      const again = await api.requestCommand({
        tenantId: tenant,
        integrationInstanceId: instanceId,
        commandType: 'RESYNC_IN_HOUSE',
        payload: {},
        idempotencyKey: `resync-${stamp}`,
        requestedBy: { type: 'SYSTEM', id: null },
      });
      expect(again.id).toBe(command.id);
      const done = await until(async () => {
        const c = await api.getCommand(tenant, command.id);
        return c?.status === 'ACKNOWLEDGED' ? c : undefined;
      });
      expect(done.attempts).toBe(1);
      expect(client.stats.commands).toBe(1);
      expect(client.stats.rejectedCommands).toBe(0);
      await expect(
        api.requestCommand({
          tenantId: tenant,
          integrationInstanceId: instanceId,
          commandType: 'OPEN_SHELL',
          payload: {},
          idempotencyKey: `x-${stamp}`,
          requestedBy: { type: 'SYSTEM', id: null },
        }),
      ).rejects.toMatchObject({ code: 'integration.command.unknown' });
    });

    it('reconciles the PMS in-house list with the platform: MATCH and every discrepancy', async () => {
      const project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));
      const reconcile = reconcileOnce(app.get(IdempotentConsumer), app.get(StayReconciler));
      const projectAll = async () => {
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
      };
      const id = (x: string) => `REC-${x}-${stamp}`;
      for (const [x, room] of [
        ['A', '504'],
        ['B', '505'],
        ['C', '506'],
      ] as const) {
        pms.reserve({
          id: id(x),
          guest: { first: 'Rec', last: x },
          arrival: '2026-10-05',
          departure: '2026-10-07',
        });
        pms.checkIn(id(x), room);
      }
      await client.drained();
      await projectAll();
      // Discrepancies that exist only in the PMS (nothing was sent): B moved, C left, D unknown to the platform.
      pms.reservations.get(id('B'))!.room = '506';
      pms.reservations.get(id('C'))!.status = 'CHECKED_OUT';
      pms.reservations.set(id('D'), {
        id: id('D'),
        confirmation: 'D',
        guest: { first: 'Rec', last: 'D' },
        sharers: [],
        arrival: '2026-10-05',
        departure: '2026-10-06',
        adults: 1,
        children: 0,
        room: '504',
        status: 'IN_HOUSE',
      });

      const run = await http()
        .post(`${base()}/integrations/${instanceId}/reconciliations`)
        .set('X-Test-Actor', gm())
        .expect(201);
      const snapshot = await until(async () => {
        const rows = await db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.aggregateId, run.body.id),
              eq(eventsSchema.outbox.eventType, 'integration.reconciliation.snapshot_completed'),
            ),
          );
        return rows[0];
      });
      expect(await reconcile(snapshot.envelope as EventEnvelope)).toBe('processed');
      expect(await reconcile(snapshot.envelope as EventEnvelope)).toBe('duplicate');

      const result = await http()
        .get(`${base()}/integrations/${instanceId}/reconciliations/${run.body.id}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(result.body).toMatchObject({
        status: 'COMPLETED',
        reportedInHouse: 3,
        summary: { MATCH: 1, DIFFERENT: 1, MISSING_INTERNAL: 1, MISSING_EXTERNAL: 1 },
      });
      const byOutcome = Object.fromEntries(
        (
          result.body.results as Array<{ outcome: string; externalId: string; details: object }>
        ).map((r) => [r.outcome, r]),
      );
      expect(byOutcome['MATCH']?.externalId).toBe(id('A'));
      expect(byOutcome['DIFFERENT']).toMatchObject({
        externalId: id('B'),
        details: { field: 'room' },
      });
      expect(byOutcome['MISSING_INTERNAL']?.externalId).toBe(id('D'));
      expect(byOutcome['MISSING_EXTERNAL']?.externalId).toBe(id('C'));
      // Differences are a human's job: three exceptions, and no stay was changed by the reconciliation.
      const exceptions = await http()
        .get(`${base()}/integration-exceptions?status=OPEN`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(
        (exceptions.body as Array<{ detail: { reason?: string } }>).filter(
          (e) => e.detail.reason === 'reconciliation',
        ),
      ).toHaveLength(3);
      const stays = await http()
        .get(`${base()}/stays?status=IN_HOUSE`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(stays.body).toHaveLength(3);
    });

    it('accepts HTTPS batches for large resyncs, in order and idempotently', async () => {
      client.stop();
      await until(async () => !client.connected);
      pms.reserve({
        id: `B-${stamp}`,
        guest: { first: 'Batch' },
        arrival: '2026-11-01',
        departure: '2026-11-02',
      });
      pms.reserve({
        id: `B2-${stamp}`,
        guest: { first: 'Batch2' },
        arrival: '2026-11-03',
        departure: '2026-11-04',
      });
      expect(queue.depth).toBe(2);
      const before = (await messages()).length;
      const res = await client.sendBatch();
      expect(res.resend_from).toBeNull();
      expect(queue.depth).toBe(0);
      expect((await messages()).length).toBe(before + 2);
    });

    it('revocation closes the link at once and the certificate stops working', async () => {
      client.start();
      await until(async () => client.connected);
      await http()
        .post(`${base()}/integrations/${instanceId}/agent/revoke`)
        .set('X-Test-Actor', gm())
        .send({ reason: 'decommissioned test agent' })
        .expect(200);
      await until(async () => client.revoked, 10_000);
      expect(client.connected).toBe(false);
      await expect(client.sendBatch().catch((e: HttpError) => e.status)).resolves.toBe(401);
      const audit = await db.execute<{ action: string }>(
        sql`select action from audit.audit_log where entity_id = ${instanceId} order by occurred_at`,
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'integration.agent.enrollment_token.create',
          'integration.agent.enroll',
          'integration.agent.revoke',
        ]),
      );
    });
  },
);
