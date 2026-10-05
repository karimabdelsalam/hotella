import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
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
import { EventsModule, eventsSchema } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inboundEndpoints, integrationMessages } from './infrastructure/schema';
import { IntegrationsModule } from './integrations.module';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const ALL = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'integration.read',
  'integration.configure',
  'integration.mapping.confirm',
];

describe.skipIf(needsInfra())(
  `Signed webhook ingress against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let app: INestApplication;
    let db: Database;
    let tenantA: string;
    let tenantB: string;
    let propertyA: string;
    let instanceId: string;
    let endpointId: string;
    let secret: string;
    let version: number;
    const http = () => request(app.getHttpServer());
    const gm = () => user('gm', tenantA);
    const base = () => `/properties/${propertyA}/integrations`;
    const endpoints = () => `${base()}/${instanceId}/inbound-endpoints`;
    const sign = (key: string, body: string, at = Math.floor(Date.now() / 1000)) =>
      `t=${at},v1=${createHmac('sha256', key).update(`${at}.${body}`).digest('hex')}`;
    const post = (body: string, signature?: string, id = endpointId) => {
      const r = http().post(`/integrations/inbound/${id}`).set('Content-Type', 'application/json');
      return (signature ? r.set('X-Hotella-Signature', signature) : r).send(body);
    };
    const batch = (...records: Array<[id: string, record: string]>) =>
      JSON.stringify({
        messages: records.map(([id, record]) => ({
          message_type: 'FIAS_RECORD',
          source_message_id: id,
          payload: { record },
        })),
      });

    beforeAll(async () => {
      await runMigrations(url);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_inbound'),
        VALKEY_URL: 'redis://127.0.0.1:1',
        WEBHOOK_SIGNING_KEY_REF: 'env://WEBHOOK_KEY',
      };
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ env }),
          ObservabilityModule.forRoot(),
          I18nModule.forRoot(),
          SecretsModule.forRoot({
            providers: [new EnvSecretProvider({ WEBHOOK_KEY: 'test-inbound-signing-key' })],
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
              useValue: new StaticPermissionResolver({ gm: ALL, other: ALL }),
            },
            propertyVerifier: OrganizationModule.propertyVerifier(),
            stages: [IntegrationsModule.capabilityStage()],
          }),
          OrganizationModule,
          IntegrationsModule,
        ],
      }).compile();
      // The ingress verifies the signature over the exact bytes received, as in apps/api.
      app = ref.createNestApplication({ logger: false, rawBody: true });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
      db = app.get(DATABASE);

      for (const code of ['a', 'b']) {
        const id = (
          await http()
            .post('/tenants')
            .set('X-Test-Actor', admin)
            .send({ code: `inb-${code}-${stamp}`, name: code })
            .expect(201)
        ).body.id as string;
        if (code === 'a') tenantA = id;
        else tenantB = id;
      }
      propertyA = (
        await http()
          .post('/properties')
          .set('X-Test-Actor', gm())
          .send({ code: 'INB', name: 'Inbound', timezone: 'Africa/Cairo', currency: 'EGP' })
          .expect(201)
      ).body.id;
      const tree = await http()
        .get(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', gm())
        .expect(200);
      const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
      await http()
        .post(`/properties/${propertyA}/rooms`)
        .set('X-Test-Actor', gm())
        .send({ parentId: root, roomNumber: '301' })
        .expect(201);
      instanceId = (
        await http()
          .post(base())
          .set('X-Test-Actor', gm())
          .send({ connectorCode: 'SIM_PMS', name: 'Cloud PMS', capabilities: ['CHECKIN_EVENT'] })
          .expect(201)
      ).body.id;
      await http()
        .patch(`${base()}/${instanceId}`)
        .set('X-Test-Actor', gm())
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      await http()
        .post(`${base()}/${instanceId}/mappings/rooms-by-number`)
        .set('X-Test-Actor', gm())
        .expect(200);
    });
    afterAll(() => app?.close());

    it('creates an endpoint only for a connector that accepts webhooks, showing the secret once', async () => {
      const fias = (
        await http()
          .post(base())
          .set('X-Test-Actor', gm())
          .send({ connectorCode: 'OPERA5_FIAS', name: 'IFC8', capabilities: ['CHECKIN_EVENT'] })
          .expect(201)
      ).body.id;
      const refused = await http()
        .post(`${base()}/${fias}/inbound-endpoints`)
        .set('X-Test-Actor', gm())
        .expect(409);
      expect(refused.body.code).toBe('integration.inbound.not_supported');

      const created = await http().post(endpoints()).set('X-Test-Actor', gm()).expect(201);
      endpointId = created.body.endpoint.id;
      secret = created.body.secret;
      version = created.body.endpoint.version;
      expect(secret).toMatch(/^whin_/);
      expect(created.body.endpoint).toMatchObject({
        status: 'ACTIVE',
        secretVersion: 1,
        path: `/integrations/inbound/${endpointId}`,
      });
      // The secret is derived, never stored, and never listed again.
      const [row] = await db
        .select()
        .from(inboundEndpoints)
        .where(eq(inboundEndpoints.id, endpointId));
      expect(JSON.stringify(row)).not.toContain(secret);
      const list = await http().get(endpoints()).set('X-Test-Actor', gm()).expect(200);
      expect(list.body).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(secret);
    });

    it('turns a signed batch into canonical events through the ingest pipeline, idempotently', async () => {
      const body = batch([
        `wh-gi-${stamp}`,
        'GI|RN301|G#W100|GNNile|GFAmira|GLar|GA261003|GD261006|DA261003|TI143000|',
      ]);
      const first = await post(body, sign(secret, body)).expect(200);
      expect(first.body.results).toEqual([
        { source_message_id: `wh-gi-${stamp}`, outcome: 'accepted', status: 'PROCESSED' },
      ]);
      const [message] = await db
        .select()
        .from(integrationMessages)
        .where(
          and(
            eq(integrationMessages.instanceId, instanceId),
            eq(integrationMessages.sourceMessageId, `wh-gi-${stamp}`),
          ),
        );
      expect(message!.sequenceNo).toBeNull();
      const events = await db
        .select()
        .from(eventsSchema.outbox)
        .where(eq(eventsSchema.outbox.aggregateId, message!.id));
      expect(events.map((e) => (e.envelope as { event_type: string }).event_type)).toEqual([
        'hotel.guest.checked_in',
      ]);
      // A vendor retry (new signature, same message) is a duplicate, not a second check-in.
      const again = await post(body, sign(secret, body)).expect(200);
      expect(again.body.results[0]).toMatchObject({ outcome: 'duplicate', status: 'PROCESSED' });

      const [touched] = await db
        .select()
        .from(inboundEndpoints)
        .where(eq(inboundEndpoints.id, endpointId));
      expect(touched!.lastUsedAt).not.toBeNull();
    });

    it('refuses missing, stale, tampered or foreign signatures without ingesting anything', async () => {
      const body = batch([`wh-bad-${stamp}`, 'GO|RN301|G#W100|DA261006|TI110000|']);
      const old = Math.floor(Date.now() / 1000) - 3600;
      for (const signature of [
        undefined,
        'garbage',
        sign(secret, body, old),
        sign(secret, `${body} `),
        sign('whin_someone-else', body),
      ]) {
        const r = await post(body, signature).expect(401);
        expect(r.body.code).toBe('integration.inbound.bad_signature');
      }
      const stored = await db
        .select()
        .from(integrationMessages)
        .where(eq(integrationMessages.sourceMessageId, `wh-bad-${stamp}`));
      expect(stored).toHaveLength(0);
      // A correctly signed but malformed batch is a validation error, not an ingest.
      const empty = JSON.stringify({ messages: [] });
      expect((await post(empty, sign(secret, empty)).expect(400)).body.code).toBe(
        'platform.validation_failed',
      );
    });

    it('rotation invalidates the old secret at once', async () => {
      const rotated = await http()
        .post(`${endpoints()}/${endpointId}/rotate`)
        .set('X-Test-Actor', gm())
        .send({ version })
        .expect(200);
      expect(rotated.body.endpoint.secretVersion).toBe(2);
      expect(rotated.body.secret).not.toBe(secret);
      await http()
        .post(`${endpoints()}/${endpointId}/rotate`)
        .set('X-Test-Actor', gm())
        .send({ version })
        .expect(409);
      const body = batch([`wh-rot-${stamp}`, 'GO|RN301|G#W100|DA261006|TI110000|']);
      await post(body, sign(secret, body)).expect(401);
      secret = rotated.body.secret;
      version = rotated.body.endpoint.version;
      const ok = await post(body, sign(secret, body)).expect(200);
      expect(ok.body.results[0].outcome).toBe('accepted');
    });

    it('is invisible to another tenant and gone once revoked', async () => {
      const other = user('other', tenantB);
      await http().get(endpoints()).set('X-Test-Actor', other).expect(404);
      await http()
        .delete(`${endpoints()}/${endpointId}?version=${version}`)
        .set('X-Test-Actor', other)
        .expect(404);
      await http()
        .delete(`${endpoints()}/${endpointId}?version=${version}`)
        .set('X-Test-Actor', gm())
        .expect(200);
      const body = batch([`wh-rev-${stamp}`, 'GO|RN301|G#W100|DA261006|TI110000|']);
      const gone = await post(body, sign(secret, body)).expect(404);
      expect(gone.body.code).toBe('integration.inbound.not_found');
      await post(body, sign(secret, body), 'not-a-uuid').expect(404);
      const again = await http()
        .post(`${endpoints()}/${endpointId}/rotate`)
        .set('X-Test-Actor', gm())
        .send({ version: version + 1 })
        .expect(409);
      expect(again.body.code).toBe('integration.inbound.revoked');
    });
  },
);
