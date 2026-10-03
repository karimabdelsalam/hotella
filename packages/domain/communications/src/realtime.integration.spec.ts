import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { and, asc, eq, sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import type { EventEnvelope } from '@hotella/contracts-events';
import { GuestModule } from '@hotella/domain-guest';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { IDENTITY_API } from '@hotella/domain-identity/public';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { OperationsModule } from '@hotella/domain-operations';
import { OrganizationModule } from '@hotella/domain-organization';
import { AuditModule } from '@hotella/platform-audit';
import {
  AUTHENTICATION_STRATEGY,
  type AuthenticationStrategy,
  AuthModule,
  PERMISSION_RESOLVER,
  type RequestActor,
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
import { EventsModule, eventsSchema } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { QueueModule, VALKEY } from '@hotella/platform-queue';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeGateway } from './api/realtime.gateway';
import { REALTIME_CHANNEL_PREFIX, RealtimeRelay } from './application/realtime-relay';
import { CommunicationsModule, CommunicationsRealtimeModule } from './communications.module';
import { roomQrCodes } from './infrastructure/schema';

const infra = readTestInfra();
const stamp = Date.now().toString(36).toUpperCase();
const PERMS = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'inbox.read',
  'qr.manage',
];

/** Bearer tokens of this suite name the actor directly (the identity context's JWT strategy is tested there). */
class TokenStrategy implements AuthenticationStrategy {
  static readonly actors = new Map<string, RequestActor>();
  async authenticate(req: Request): Promise<RequestActor | null> {
    const header = req.headers.authorization ?? '';
    return TokenStrategy.actors.get(header.replace(/^Bearer /, '')) ?? null;
  }
}

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
    RealtimeRelay,
  ],
  exports: [IDENTITY_API, RealtimeRelay],
})
class TestSupportModule {}

/** A WebSocket client that collects frames and can wait for one. */
function client(url: string) {
  const ws = new WebSocket(url);
  const frames: Array<Record<string, unknown>> = [];
  let closed: number | null = null;
  ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as Record<string, unknown>));
  ws.on('close', (code) => (closed = code));
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  const waitFor = async (pred: (f: Record<string, unknown>) => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const f = frames.find(pred);
      if (f) return f;
      if (Date.now() > end) throw new Error(`no frame matched; got ${JSON.stringify(frames)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const waitClosed = async (ms = 5_000) => {
    const end = Date.now() + ms;
    while (closed === null && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return closed;
  };
  return {
    ws,
    frames,
    opened,
    waitFor,
    waitClosed,
    send: (o: unknown) => ws.send(JSON.stringify(o)),
  };
}

describe.skipIf(!infra.databaseUrl || !infra.valkeyUrl)(
  'Realtime gateway and QR sheet (PostgreSQL + Valkey)',
  () => {
    let app: INestApplication;
    let db: Database;
    let wsUrl: string;
    let tenantA: string;
    let tenantB: string;
    let propertyA: string;
    let propertyB: string;
    let stayId: string;
    let room504: string;
    const staffId = newId();
    const http = () => request(app.getHttpServer());
    const relayFromOutbox = async (type: string) => {
      const rows = await db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(eq(eventsSchema.outbox.tenantId, tenantA), eq(eventsSchema.outbox.eventType, type)),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt));
      await app.get(RealtimeRelay).apply(rows.at(-1)!.envelope as EventEnvelope);
    };

    beforeAll(async () => {
      await runMigrations(infra.databaseUrl!);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: await applicationRoleUrl(infra.databaseUrl!, 'hotella_app_comms_rt'),
        VALKEY_URL: infra.valkeyUrl!,
      };
      const grants: Record<string, string[]> = { [staffId]: PERMS, admin: [] };
      const ref = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ env }),
          ObservabilityModule.forRoot(),
          I18nModule.forRoot(),
          SecretsModule.forRoot({
            providers: [new EnvSecretProvider({ COMMS_OTP_HMAC_KEY: 'k' })],
          }),
          HttpConventionsModule.forRoot({ store: 'memory' }),
          DatabaseModule.forRoot(),
          QueueModule.forRoot(),
          EventsModule.forRoot(),
          FeatureFlagsModule,
          ManifestModule.forRoot(),
          AuditModule,
          SettingsModule,
          AuthModule.forRoot({
            strategy: { provide: AUTHENTICATION_STRATEGY, useClass: TokenStrategy },
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
          TestSupportModule,
          OperationsModule,
          CommunicationsModule,
          CommunicationsRealtimeModule,
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.listen(0, '127.0.0.1');
      wsUrl = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/realtime`;
      db = app.get(DATABASE);

      TokenStrategy.actors.set('admin-token', {
        type: 'USER',
        id: 'admin',
        tenantId: null,
        isPlatformAdmin: true,
      });
      const as = (token: string) => ({ authorization: `Bearer ${token}` });
      tenantA = (
        await http()
          .post('/tenants')
          .set(as('admin-token'))
          .send({ code: `rt-a-${stamp}`, name: 'A' })
          .expect(201)
      ).body.id;
      tenantB = (
        await http()
          .post('/tenants')
          .set(as('admin-token'))
          .send({ code: `rt-b-${stamp}`, name: 'B' })
          .expect(201)
      ).body.id;
      TokenStrategy.actors.set('staff-token', {
        type: 'USER',
        id: staffId,
        tenantId: tenantA,
        isPlatformAdmin: false,
      });
      TokenStrategy.actors.set('b-token', {
        type: 'USER',
        id: staffId,
        tenantId: tenantB,
        isPlatformAdmin: false,
      });
      propertyA = (
        await http()
          .post('/properties')
          .set(as('staff-token'))
          .send({ code: 'RTA', name: 'Sea View', timezone: 'Africa/Cairo', currency: 'EGP' })
          .expect(201)
      ).body.id;
      propertyB = (
        await http()
          .post('/properties')
          .set(as('b-token'))
          .send({ code: 'RTB', name: 'Other', timezone: 'Africa/Cairo', currency: 'EGP' })
          .expect(201)
      ).body.id;
      const tree = await http()
        .get(`/properties/${propertyA}/locations`)
        .set(as('staff-token'))
        .expect(200);
      const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
      room504 = (
        await http()
          .post(`/properties/${propertyA}/rooms`)
          .set(as('staff-token'))
          .send({ parentId: root, roomNumber: '504' })
          .expect(201)
      ).body.locationId;
      await http()
        .post(`/properties/${propertyA}/rooms`)
        .set(as('staff-token'))
        .send({ parentId: root, roomNumber: '505' })
        .expect(201);

      const mona = newId();
      stayId = newId();
      const today = new Date().toISOString().slice(0, 10);
      const departure = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await db.execute(
        sql`insert into guest.guests (id, tenant_id, given_name, family_name) values (${mona}, ${tenantA}, 'Mona', 'Delta')`,
      );
      await db.execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, actual_checkin_at, last_pms_event_at)
      values (${stayId}, ${tenantA}, ${propertyA}, 'IN_HOUSE', ${mona}, ${today}, ${departure}, now(), now())`);
      await db.execute(
        sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at) values (${newId()}, ${tenantA}, ${stayId}, ${mona}, 'PRIMARY', now())`,
      );
      await db.execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
      values (${newId()}, ${tenantA}, ${propertyA}, ${stayId}, ${room504}, now(), 'INITIAL')`);
    });
    afterAll(() => app?.close());

    it('staff and the guest hear about the conversation; strangers and other properties do not', async () => {
      const guests = app.get<GuestPublicApi>(GUEST_API);
      const grant = await guests.issueGrant({
        tenantId: tenantA,
        propertyId: propertyA,
        stayId,
        guestId: (await guests.stayParty(tenantA, stayId))[0]!.guestId,
        via: 'STAFF',
        actor: { type: 'USER', id: staffId },
      });
      const session = await guests.openGuestSession(tenantA, grant.id, null);

      const staff = client(wsUrl);
      await staff.opened;
      staff.send({ type: 'auth', token: 'staff-token' });
      await staff.waitFor((f) => f.type === 'ready' && f.as === 'staff');
      staff.send({ type: 'subscribe', propertyId: propertyA });
      await staff.waitFor((f) => f.type === 'subscribed');
      staff.send({ type: 'subscribe', propertyId: propertyB });
      await staff.waitFor((f) => f.type === 'error' && f.code === 'platform.forbidden');

      const guest = client(wsUrl);
      await guest.opened;
      guest.send({ type: 'guest', session: session.token });
      await guest.waitFor((f) => f.type === 'ready' && f.as === 'guest');

      const stranger = client(wsUrl);
      await stranger.opened;
      stranger.send({ type: 'auth', token: 'forged-token-123' });
      expect(await stranger.waitClosed()).toBe(4401);

      await http()
        .post('/guest/conversation/messages')
        .set('X-Guest-Session', session.token)
        .send({ body: 'Hello' })
        .expect(201);
      await relayFromOutbox('comms.message.received');
      const seen = await staff.waitFor((f) => f.type === 'event');
      expect(seen).toMatchObject({ event: 'comms.message.received', propertyId: propertyA });
      expect(seen).not.toHaveProperty('body');
      await guest.waitFor((f) => f.type === 'event' && f.event === 'comms.message.received');

      // A notice for another stay of the tenant reaches staff but not this guest.
      const valkey = app.get<Redis>(VALKEY);
      await valkey.publish(
        `${REALTIME_CHANNEL_PREFIX}${tenantA}`,
        JSON.stringify({
          event: 'comms.message.sent',
          tenantId: tenantA,
          propertyId: propertyA,
          conversationId: newId(),
          stayId: newId(),
          messageId: null,
        }),
      );
      await staff.waitFor((f) => f.type === 'event' && f.event === 'comms.message.sent');
      await new Promise((r) => setTimeout(r, 200));
      expect(guest.frames.filter((f) => f.event === 'comms.message.sent')).toHaveLength(0);

      // A revoked session ends the socket at the next check.
      await guests.revokeGuestSession(tenantA, session.sessionId, 'LOGOUT');
      await app.get(RealtimeGateway).revalidateNow();
      expect(await guest.waitClosed()).toBe(4401);
      staff.ws.close();
    });

    it('prints a localized, RTL-aware sheet of fresh room codes; earlier codes stop working', async () => {
      const as = { authorization: 'Bearer staff-token' };
      const first = await http()
        .post(`/properties/${propertyA}/rooms/${room504}/qr-code`)
        .set(as)
        .expect(201);
      const sheet = await http()
        .post(`/properties/${propertyA}/room-qr-codes/sheet`)
        .set(as)
        .send({})
        .expect(200);
      expect(sheet.headers['content-type']).toMatch(/text\/html/);
      expect(sheet.headers['cache-control']).toBe('no-store');
      expect(sheet.text).toContain('dir="ltr"');
      expect(sheet.text.match(/<svg/g)).toHaveLength(2);
      expect(sheet.text).toContain('Room 504');
      expect(sheet.text).toContain('Powered by Planova');
      await http().get(`/guest/qr/${first.body.token}`).expect(404);
      const active = await db
        .select()
        .from(roomQrCodes)
        .where(and(eq(roomQrCodes.propertyId, propertyA), eq(roomQrCodes.status, 'ACTIVE')));
      expect(active).toHaveLength(2);

      const ar = await http()
        .post(`/properties/${propertyA}/room-qr-codes/sheet`)
        .set(as)
        .set('Accept-Language', 'ar')
        .send({ roomIds: [room504] })
        .expect(200);
      expect(ar.text).toContain('dir="rtl"');
      expect(ar.text).toContain('غرفة 504');
      await http()
        .post(`/properties/${propertyA}/room-qr-codes/sheet`)
        .set(as)
        .send({ roomIds: [newId()] })
        .expect(404);
    });
  },
);
