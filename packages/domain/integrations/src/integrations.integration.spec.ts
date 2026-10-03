import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, asc, eq, sql } from 'drizzle-orm';
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
  withTransaction,
} from '@hotella/platform-database';
import { EventsModule, eventsSchema } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IngestService } from './application/ingest.service';
import { integrationExceptions, integrationMessages } from './infrastructure/schema';
import { IntegrationsModule } from './integrations.module';
import { EXTERNAL_ENTITY, INTEGRATIONS_API, type IntegrationsPublicApi } from './public';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
/** Reads a dotted path out of stored JSON for assertions. */
const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], value);
const ALL = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'integration.read',
  'integration.configure',
  'integration.replay',
  'integration.mapping.confirm',
];

describe.skipIf(needsInfra())(
  `Integration Platform against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let app: INestApplication;
    let db: Database;
    let ingest: IngestService;
    let api: IntegrationsPublicApi;
    let tenantA: string;
    let tenantB: string;
    let propertyA: string;
    let instanceId: string;
    const rooms: Record<string, string> = {};
    const grants: Record<string, string[]> = { gm: ALL, other: ALL };
    let seq = 0;
    const http = () => request(app.getHttpServer());
    const gm = () => user('gm', tenantA);
    const base = () => `/properties/${propertyA}/integrations`;
    const fias = (record: string, id = `m-${stamp}-${++seq}`) =>
      ingest.ingest(instanceId, {
        message_type: 'FIAS_RECORD',
        source_message_id: id,
        sequence_no: seq,
        payload: { record },
      });
    const eventsOf = (messageId: string) =>
      db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.aggregateType, 'integration_message'),
            eq(eventsSchema.outbox.aggregateId, messageId),
          ),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt));
    const message = (id: string) =>
      db
        .select()
        .from(integrationMessages)
        .where(eq(integrationMessages.id, id))
        .then((r) => r[0]!);

    beforeAll(async () => {
      await runMigrations(url);
      // The application runs as an ordinary role so row-level security is really enforced.
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: await applicationRoleUrl(url),
        VALKEY_URL: 'redis://127.0.0.1:1',
      };
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ env }),
          ObservabilityModule.forRoot(),
          I18nModule.forRoot(),
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
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
      db = app.get(DATABASE);
      ingest = app.get(IngestService);
      api = app.get(INTEGRATIONS_API);

      tenantA = (
        await http()
          .post('/tenants')
          .set('X-Test-Actor', admin)
          .send({ code: `int-a-${stamp}`, name: 'A' })
          .expect(201)
      ).body.id;
      tenantB = (
        await http()
          .post('/tenants')
          .set('X-Test-Actor', admin)
          .send({ code: `int-b-${stamp}`, name: 'B' })
          .expect(201)
      ).body.id;
      propertyA = (
        await http()
          .post('/properties')
          .set('X-Test-Actor', gm())
          .send({ code: 'CAI', name: 'Cairo', timezone: 'Africa/Cairo', currency: 'EGP' })
          .expect(201)
      ).body.id;
      const tree = await http()
        .get(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', gm())
        .expect(200);
      const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
      for (const n of ['504', '505']) {
        rooms[n] = (
          await http()
            .post(`/properties/${propertyA}/rooms`)
            .set('X-Test-Actor', gm())
            .send({ parentId: root, roomNumber: n })
            .expect(201)
        ).body.locationId;
      }
    });
    afterAll(() => app?.close());

    it('lists the connector catalog and validates instance capabilities and config', async () => {
      const catalog = await http()
        .get(`${base()}/connectors`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(catalog.body.map((c: { code: string }) => c.code)).toContain('SIM_PMS');
      const bad = await http()
        .post(base())
        .set('X-Test-Actor', gm())
        .send({ connectorCode: 'SIM_PMS', name: 'x', capabilities: ['ORDER_CREATE'] })
        .expect(422);
      expect(bad.body.code).toBe('integration.instance.capability_unsupported');
      await http()
        .post(base())
        .set('X-Test-Actor', gm())
        .send({ connectorCode: 'NOPE', name: 'x', capabilities: ['CHECKIN_EVENT'] })
        .expect(404);
    });

    it('creates a FIAS-face instance (no reservation reads) and activates it', async () => {
      const created = await http()
        .post(base())
        .set('X-Test-Actor', gm())
        .send({
          connectorCode: 'SIM_PMS',
          name: 'Simulator',
          capabilities: [
            'CHECKIN_EVENT',
            'CHECKOUT_EVENT',
            'ROOM_MOVE_EVENT',
            'PROFILE_EVENT',
            'ROOM_STATUS_READ',
          ],
        })
        .expect(201);
      instanceId = created.body.id;
      expect(created.body.status).toBe('DRAFT');
      expect(created.body.effectiveCapabilities).toEqual([]);
      await expect(fias('LS|')).rejects.toMatchObject({ code: 'integration.instance.not_active' });
      const active = await http()
        .patch(`${base()}/${instanceId}`)
        .set('X-Test-Actor', gm())
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      expect(active.body.effectiveCapabilities).toContain('CHECKIN_EVENT');
      await http()
        .patch(`${base()}/${instanceId}`)
        .set('X-Test-Actor', gm())
        .send({ version: 1, name: 'stale' })
        .expect(409);
    });

    it('parks a check-in for an unmapped room, holds its check-out, and ignores duplicates', async () => {
      const gi = await fias(
        'GI|RN504|G#R100|GNNile|GFAmira|GLar|GA261003|GD261006|DA261003|TI143000|',
        `gi-${stamp}`,
      );
      expect(gi).toMatchObject({ outcome: 'accepted', status: 'PENDING_MAPPING' });
      expect(await eventsOf(gi.messageId)).toHaveLength(0);
      const go = await fias('GO|RN504|G#R100|DA261006|TI110000|', `go-${stamp}`);
      expect(go.status).toBe('HELD');
      const dup = await fias('GI|RN504|G#R100|GNNile|GFAmira|GD261006|', `gi-${stamp}`);
      expect(dup).toMatchObject({ outcome: 'duplicate', messageId: gi.messageId });

      const exceptions = await http()
        .get(`/properties/${propertyA}/integration-exceptions?status=OPEN`)
        .set('X-Test-Actor', gm())
        .expect(200);
      const unknownRoom = exceptions.body.filter(
        (e: { kind: string; externalCode: string }) =>
          e.kind === 'UNKNOWN_MAPPING' && e.externalCode === '504',
      );
      expect(unknownRoom).toHaveLength(1);
      expect(unknownRoom[0].occurrences).toBe(1);

      // Ordered raw messages are visible as metadata only, never with their payload.
      const list = await http()
        .get(`${base()}/${instanceId}/messages`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(list.body[0]).not.toHaveProperty('payload');
    });

    it('a confirmed mapping plus replay releases the parked message and its successors in order', async () => {
      const bad = await http()
        .post(`${base()}/${instanceId}/mappings`)
        .set('X-Test-Actor', gm())
        .send({ mappingType: 'ROOM', externalCode: '504', internalValue: tenantB })
        .expect(422);
      expect(bad.body.code).toBe('integration.mapping.room_not_found');
      const seeded = await http()
        .post(`${base()}/${instanceId}/mappings/rooms-by-number`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(seeded.body).toEqual({ rooms: 2, created: 2 });
      const open = await db
        .select()
        .from(integrationExceptions)
        .where(
          and(
            eq(integrationExceptions.instanceId, instanceId),
            eq(integrationExceptions.status, 'OPEN'),
            eq(integrationExceptions.kind, 'UNKNOWN_MAPPING'),
          ),
        );
      expect(open.filter((e) => e.externalCode === '504')).toHaveLength(0);

      const replay = await http()
        .post(`${base()}/${instanceId}/messages/replay-pending`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(replay.body.replayed).toBe(1);

      const gi = await ingest.ingest(instanceId, {
        message_type: 'FIAS_RECORD',
        source_message_id: `gi-${stamp}`,
        payload: {},
      });
      expect(gi).toMatchObject({ outcome: 'duplicate', status: 'PROCESSED' });
      const [checkedIn] = await eventsOf(gi.messageId);
      const envelope = checkedIn!.envelope;
      expect(at(envelope, 'event_type')).toBe('hotel.guest.checked_in');
      expect(at(envelope, 'source')).toBe('integration:SIM_PMS');
      expect(at(envelope, 'tenant_id')).toBe(tenantA);
      expect(at(envelope, 'property_id')).toBe(propertyA);
      expect(at(envelope, 'payload.room')).toEqual({ room_id: rooms['504'], room_number: '504' });
      expect(at(envelope, 'payload.reservation')).toMatchObject({
        integration_instance_id: instanceId,
        external_id: 'R100',
      });
      expect(at(envelope, 'payload.primary_guest')).toMatchObject({
        given_name: 'Amira',
        family_name: 'Nile',
        locale: 'ar',
      });
      // FIAS wall-clock 14:30 in Cairo (UTC+3 in October 2026, Egyptian summer time) → 11:30Z.
      expect(at(envelope, 'payload.checked_in_at')).toBe('2026-10-03T11:30:00.000Z');
      expect(at(envelope, 'payload.departure_date')).toBe('2026-10-06');

      const goMessage = await db
        .select()
        .from(integrationMessages)
        .where(
          and(
            eq(integrationMessages.instanceId, instanceId),
            eq(integrationMessages.sourceMessageId, `go-${stamp}`),
          ),
        )
        .then((r) => r[0]!);
      expect(goMessage.status).toBe('PROCESSED');
      const [checkedOut] = await eventsOf(goMessage.id);
      expect(at(checkedOut!.envelope, 'event_type')).toBe('hotel.guest.checked_out');
      expect(checkedOut!.createdAt.getTime()).toBeGreaterThanOrEqual(
        checkedIn!.createdAt.getTime(),
      );
    });

    it('turns a room move into hotel.stay.room_changed and leaves unmapped optional codes empty', async () => {
      const move = await fias('GC|RN505|RO504|G#R100|DA261004|TI090000|');
      expect(move.status).toBe('PROCESSED');
      const [changed] = await eventsOf(move.messageId);
      const p = at(changed!.envelope, 'payload');
      expect(at(p, 'from_room.room_id')).toBe(rooms['504']);
      expect(at(p, 'to_room.room_id')).toBe(rooms['505']);

      const vip1 = await fias('GI|RN505|G#R200|GNStone|GFOmar|GVGOLD|GD261009|');
      const vip2 = await fias('GC|RN505|G#R200|GVGOLD|GFOmar|');
      expect([vip1.status, vip2.status]).toEqual(['PROCESSED', 'PROCESSED']);
      const [ev] = await eventsOf(vip1.messageId);
      expect(at(ev!.envelope, 'payload.primary_guest.vip_code')).toBeNull();
      const [vipException] = await db
        .select()
        .from(integrationExceptions)
        .where(
          and(
            eq(integrationExceptions.instanceId, instanceId),
            eq(integrationExceptions.externalCode, 'GOLD'),
            eq(integrationExceptions.status, 'OPEN'),
          ),
        );
      expect(vipException).toMatchObject({ mappingType: 'VIP', occurrences: 2 });

      await http()
        .post(`${base()}/${instanceId}/mappings`)
        .set('X-Test-Actor', gm())
        .send({ mappingType: 'VIP', externalCode: 'GOLD', internalValue: 'VIP2' })
        .expect(200);
      const vip3 = await fias('GC|RN505|G#R200|GVGOLD|GFOmar|');
      const [ev3] = await eventsOf(vip3.messageId);
      expect(at(ev3!.envelope, 'payload.profile.vip_code')).toBe('VIP2');
    });

    it('rejects capabilities the hotel has not enabled and records parse errors', async () => {
      const ows = await ingest.ingest(instanceId, {
        message_type: 'OWS_RESERVATION',
        source_message_id: `ows-${stamp}`,
        payload: { action: 'NEW' },
      });
      expect(ows.status).toBe('REJECTED');
      const broken = await fias('GI|RN505|');
      expect(broken.status).toBe('FAILED');
      expect((await message(broken.messageId)).error).toContain('reservation number');
      const kinds = (
        await db
          .select()
          .from(integrationExceptions)
          .where(eq(integrationExceptions.instanceId, instanceId))
      ).map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['UNSUPPORTED_MESSAGE', 'PARSE_ERROR']));
      // Replaying is allowed but changes nothing while the capability stays disabled.
      const replayed = await http()
        .post(`${base()}/${instanceId}/messages/${ows.messageId}/replay`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(replayed.body.status).toBe('REJECTED');
      const processed = await http()
        .post(`${base()}/${instanceId}/messages/${(await fias('LS|')).messageId}/replay`)
        .set('X-Test-Actor', gm())
        .expect(409);
      expect(processed.body.code).toBe('integration.message.not_replayable');

      const outbox = await db
        .select()
        .from(eventsSchema.outbox)
        .where(eq(eventsSchema.outbox.eventType, 'integration.exception.opened'));
      expect(outbox.length).toBeGreaterThanOrEqual(3);
    });

    it('answers capability questions and keeps external references inside the integration context', async () => {
      expect(await api.hasCapability(tenantA, propertyA, 'CHECKIN_EVENT')).toBe(true);
      expect(await api.hasCapability(tenantA, propertyA, 'RESERVATION_READ')).toBe(false);
      const stayId = '01920000-0000-7000-8000-000000000001';
      const otherId = '01920000-0000-7000-8000-000000000002';
      const link = (internalEntityId: string) =>
        withTransaction(
          db,
          () =>
            api.linkReference({
              tenantId: tenantA,
              integrationInstanceId: instanceId,
              internalEntityType: 'guest.stay',
              internalEntityId,
              externalEntityType: EXTERNAL_ENTITY.RESERVATION,
              externalId: 'R100',
            }),
          { tenantId: tenantA },
        );
      expect(await link(stayId)).toBe(stayId);
      // First writer wins: a concurrent consumer converges on the same internal entity.
      expect(await link(otherId)).toBe(stayId);
      expect(await api.resolveReference(tenantA, instanceId, 'RESERVATION', 'R100')).toBe(stayId);
      expect(await api.resolveReference(tenantB, instanceId, 'RESERVATION', 'R100')).toBeNull();
      const refs = await http()
        .get(
          `/properties/${propertyA}/external-references?entityType=guest.stay&entityId=${stayId}`,
        )
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(refs.body).toHaveLength(1);
    });

    it('never leaks across tenants (HTTP 404 and row-level security)', async () => {
      await http()
        .get(`${base()}/${instanceId}`)
        .set('X-Test-Actor', user('other', tenantB))
        .expect(404);
      await http()
        .get(`/properties/${propertyA}/integration-exceptions`)
        .set('X-Test-Actor', user('other', tenantB))
        .expect(404);
      const visible = await withTransaction(
        db,
        (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(integrationMessages),
        { tenantId: tenantB },
      );
      expect(visible[0]!.n).toBe(0);
    });
  },
);
