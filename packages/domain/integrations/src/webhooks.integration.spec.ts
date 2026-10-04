import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { ENTITLEMENT_API } from '@hotella/domain-licensing/public';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import {
  type ActionRequest,
  AUTHENTICATION_STRATEGY,
  AuthModule,
  ENTITLEMENT_STAGE,
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
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { AppError, I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookDispatcher } from './application/webhook-delivery';
import { webhookDeliveries } from './infrastructure/schema';
import { IntegrationsModule } from './integrations.module';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const ALL = ['org.property.read', 'org.property.manage', 'integration.webhook.manage'];

/** Entitlements of the test: tenants that hold API_ACCESS (the real engine is tested in the licensing context). */
const entitled = new Set<string>();

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

describe.skipIf(needsInfra())(`Outbound webhooks against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let dispatcher: WebhookDispatcher;
  let server: Server;
  let target: string;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  const received: Received[] = [];
  let reply = 200;
  const http = () => request(app.getHttpServer());
  const gm = () => user('gm', tenantA);
  const base = () => `/tenants/${tenantA}/webhooks`;
  const envelope = (
    type: string,
    tenantId: string,
    propertyId: string | null = null,
  ): EventEnvelope => ({
    event_id: newId(),
    event_type: type,
    event_version: 1,
    tenant_id: tenantId,
    property_id: propertyId,
    source: 'ops',
    source_reference: null,
    occurred_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    correlation_id: null,
    payload: { task_id: newId() },
  });
  const deliveryOf = (eventId: string) =>
    db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.eventId, eventId))
      .then((r) => r);
  const verify = (secret: string, r: Received): boolean => {
    const [t, v1] = String(r.headers['x-hotella-signature'])
      .split(',')
      .map((p) => p.split('=')[1]!);
    return createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex') === v1;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = reply;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_webhooks'),
      VALKEY_URL: 'redis://127.0.0.1:1',
      WEBHOOK_SIGNING_KEY_REF: 'env://WEBHOOK_KEY',
      WEBHOOK_ALLOW_INSECURE: 'true',
    };
    const grants: Record<string, string[]> = { gm: ALL, other: ALL };
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        SecretsModule.forRoot({
          providers: [new EnvSecretProvider({ WEBHOOK_KEY: 'test-webhook-signing-key' })],
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
          stages: [
            {
              provide: ENTITLEMENT_STAGE,
              useValue: {
                name: 'entitlement',
                async check(r: ActionRequest) {
                  if (r.entitlement && r.tenantId && !entitled.has(r.tenantId))
                    throw AppError.forbidden('license.not_entitled', { capability: r.entitlement });
                },
              },
            },
          ],
        }),
        OrganizationModule,
        IntegrationsModule,
      ],
      providers: [
        WebhookDispatcher,
        {
          provide: ENTITLEMENT_API,
          useValue: { can: async (t: string) => entitled.has(t) },
        },
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    dispatcher = app.get(WebhookDispatcher);
    for (const code of ['a', 'b']) {
      const id = (
        await http()
          .post('/tenants')
          .set('X-Test-Actor', admin)
          .send({ code: `wh-${code}-${stamp}`, name: code })
          .expect(201)
      ).body.id as string;
      if (code === 'a') tenantA = id;
      else tenantB = id;
    }
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({ code: 'WHK', name: 'Hooks', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise((r) => server?.close(r));
  });
  beforeEach(() => {
    received.length = 0;
    reply = 200;
  });

  it('needs the API_ACCESS entitlement', async () => {
    const res = await http().get(base()).set('X-Test-Actor', gm()).expect(403);
    expect(res.body.code).toBe('license.not_entitled');
    expect(res.body.params).toEqual({ capability: 'API_ACCESS' });
    entitled.add(tenantA);
    entitled.add(tenantB);
    await http().get(base()).set('X-Test-Actor', gm()).expect(200);
  });

  it('validates the target and the events, and shows the secret only once', async () => {
    const bad = await http()
      .post(base())
      .set('X-Test-Actor', gm())
      .send({ url: 'ftp://x', eventTypes: ['ops.task.assigned.v1'] })
      .expect(422);
    expect(bad.body.code).toBe('integration.webhook.url_invalid');
    await http()
      .post(base())
      .set('X-Test-Actor', gm())
      .send({ url: target, eventTypes: ['hotel.guest.checked_in.v1'] })
      .expect(400);
    const created = await http()
      .post(base())
      .set('X-Test-Actor', gm())
      .send({ url: target, eventTypes: ['ops.task.assigned.v1', 'ops.sla.breached.v1'] })
      .expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.body.endpoint.status).toBe('ACTIVE');
    const list = await http().get(base()).set('X-Test-Actor', gm()).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
  });

  it('delivers a subscribed event once, signed, and never another tenant’s', async () => {
    const created = await http()
      .post(base())
      .set('X-Test-Actor', gm())
      .send({ url: target, eventTypes: ['hk.room.ready.v1'], propertyId: propertyA })
      .expect(201);
    const secret = created.body.secret as string;
    const e = envelope('hk.room.ready', tenantA, propertyA);
    expect(await dispatcher.enqueue('hk.room.ready.v1', e)).toBe(1);
    expect(await dispatcher.enqueue('hk.room.ready.v1', e)).toBe(0);
    // Not subscribed, other tenant, other property: nothing.
    expect(await dispatcher.enqueue('hk.job.created.v1', envelope('hk.job.created', tenantA))).toBe(
      0,
    );
    expect(await dispatcher.enqueue('hk.room.ready.v1', envelope('hk.room.ready', tenantB))).toBe(
      0,
    );
    expect(
      await dispatcher.enqueue('hk.room.ready.v1', envelope('hk.room.ready', tenantA, newId())),
    ).toBe(0);

    await dispatcher.sweep();
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.headers['x-hotella-event']).toBe('hk.room.ready.v1');
    expect(JSON.parse(got.body).event_id).toBe(e.event_id);
    expect(verify(secret, got)).toBe(true);
    const [row] = await deliveryOf(e.event_id);
    expect(row!.status).toBe('DELIVERED');
    expect(row!.attempts).toBe(1);
    expect(got.headers['x-hotella-delivery']).toBe(row!.id);

    const deliveries = await http()
      .get(`${base()}/${created.body.endpoint.id}/deliveries`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(deliveries.body.map((d: { id: string }) => d.id)).toEqual([row!.id]);
    expect(JSON.stringify(deliveries.body)).not.toContain('task_id');
  });

  it('retries with back-off, dead-letters after the last attempt and replays on request', async () => {
    const created = await http()
      .post(base())
      .set('X-Test-Actor', gm())
      .send({ url: target, eventTypes: ['eng.pm.due.v1'] })
      .expect(201);
    const endpointId = created.body.endpoint.id as string;
    const e = envelope('eng.pm.due', tenantA);
    await dispatcher.enqueue('eng.pm.due.v1', e);
    reply = 500;
    const before = Date.now();
    await dispatcher.sweep();
    let [row] = await deliveryOf(e.event_id);
    expect(row!.status).toBe('PENDING');
    expect(row!.lastStatusCode).toBe(500);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    // Not due yet: the next sweep leaves it alone.
    received.length = 0;
    await dispatcher.sweep();
    expect(received).toHaveLength(0);

    // Fast-forward to the last attempt.
    await db
      .update(webhookDeliveries)
      .set({ attempts: 7, nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(webhookDeliveries.id, row!.id));
    await dispatcher.sweep();
    [row] = await deliveryOf(e.event_id);
    expect(row!.status).toBe('DEAD');
    expect(row!.attempts).toBe(8);

    const dead = await http()
      .get(`${base()}/${endpointId}/deliveries?status=DEAD`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(dead.body).toHaveLength(1);

    reply = 204;
    const replayed = await http()
      .post(`${base()}/${endpointId}/deliveries/${row!.id}/replay`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(replayed.body).toMatchObject({ status: 'PENDING', attempts: 0, replays: 1 });
    const again = await http()
      .post(`${base()}/${endpointId}/deliveries/${row!.id}/replay`)
      .set('X-Test-Actor', gm())
      .expect(409);
    expect(again.body.code).toBe('integration.webhook.delivery_pending');
    await dispatcher.sweep();
    [row] = await deliveryOf(e.event_id);
    expect(row!.status).toBe('DELIVERED');
  });

  it('rotates the secret, pauses and resumes', async () => {
    const created = await http()
      .post(base())
      .set('X-Test-Actor', gm())
      .send({ url: target, eventTypes: ['relations.complaint.opened.v1'] })
      .expect(201);
    const id = created.body.endpoint.id as string;
    const rotated = await http()
      .post(`${base()}/${id}/rotate-secret`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(rotated.body.secret).not.toBe(created.body.secret);
    expect(rotated.body.endpoint.secretVersion).toBe(2);

    const paused = await http()
      .patch(`${base()}/${id}`)
      .set('X-Test-Actor', gm())
      .send({ version: rotated.body.endpoint.version, status: 'PAUSED' })
      .expect(200);
    await http()
      .patch(`${base()}/${id}`)
      .set('X-Test-Actor', gm())
      .send({ version: rotated.body.endpoint.version, status: 'ACTIVE' })
      .expect(409);
    const e1 = envelope('relations.complaint.opened', tenantA);
    expect(await dispatcher.enqueue('relations.complaint.opened.v1', e1)).toBe(0);

    await http()
      .patch(`${base()}/${id}`)
      .set('X-Test-Actor', gm())
      .send({ version: paused.body.version, status: 'ACTIVE' })
      .expect(200);
    const e2 = envelope('relations.complaint.opened', tenantA);
    expect(await dispatcher.enqueue('relations.complaint.opened.v1', e2)).toBe(1);
    await dispatcher.sweep();
    const got = received.find((r) => JSON.parse(r.body).event_id === e2.event_id)!;
    expect(verify(rotated.body.secret, got)).toBe(true);
    expect(verify(created.body.secret, got)).toBe(false);
  });

  it('keeps tenants apart and stops fanning out when API_ACCESS ends', async () => {
    await http().get(base()).set('X-Test-Actor', user('other', tenantB)).expect(404);
    const own = await http()
      .get(`/tenants/${tenantB}/webhooks`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(200);
    expect(own.body).toEqual([]);
    const list = await http().get(base()).set('X-Test-Actor', gm()).expect(200);
    const [first] = list.body as Array<{ id: string }>;
    await http()
      .get(`/tenants/${tenantB}/webhooks/${first!.id}/deliveries`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(404);

    entitled.delete(tenantA);
    expect(
      await dispatcher.enqueue('ops.task.assigned.v1', envelope('ops.task.assigned', tenantA)),
    ).toBe(0);
    entitled.add(tenantA);
  });
});
