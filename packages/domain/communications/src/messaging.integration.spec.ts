import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { createEnvelope, StayStatusChanged } from '@hotella/contracts-events';
import { GuestModule } from '@hotella/domain-guest';
import { IDENTITY_API } from '@hotella/domain-identity/public';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { OperationsModule } from '@hotella/domain-operations';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
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
import { ActivationService } from './application/activation.service';
import { BSP_WEBHOOK_SECRET_HEADER } from './application/adapters/bsp';
import { ConversationService } from './application/conversation.service';
import { FakeSmsProvider } from './application/fake-providers';
import { ChannelAdapterRegistry } from './application/providers';
import { CommunicationsModule } from './communications.module';
import { conversations, messages } from './infrastructure/schema';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const staffId = newId();
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const PERMS = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'channel.manage',
  'guest.activation.issue',
  'inbox.read',
  'inbox.reply',
  'inbox.assign',
  'inbox.takeover',
];
const META = {
  accessToken: 'EAAG-test-access-token',
  appSecret: 'meta-app-secret-1',
  verifyToken: 'verify-token-1',
};
const D360 = { apiKey: 'd360-test-key', webhookSecret: 'bsp-webhook-secret-0001' };
const MONA = '+201001234567';
const STRANGER = '+201998877665';

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

/** A stand-in for Graph API and the BSP: records every request, answers like the Cloud API. */
interface ProviderCall {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

describe.skipIf(needsInfra())(`Messaging against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let server: Server;
  let providerBase: string;
  const calls: ProviderCall[] = [];
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  let stayId: string;
  let mona: string;
  let metaChannel: string;
  let bspChannel: string;
  let room504: string;
  let guestSession: string;
  const sms = new FakeSmsProvider();
  const grants: Record<string, string[]> = { [staffId]: PERMS, other: PERMS };
  const http = () => request(app.getHttpServer());
  const gm = () => user(staffId, tenantA);
  const base = () => `/properties/${propertyA}`;
  const signed = (body: unknown) => {
    const raw = JSON.stringify(body);
    return { raw, sig: `sha256=${createHmac('sha256', META.appSecret).update(raw).digest('hex')}` };
  };
  const cloud = (value: unknown) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [{ field: 'messages', value }] }],
  });
  const inbound = (from: string, id: string, text: string) =>
    cloud({
      messages: [
        {
          from: from.slice(1),
          id,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: text },
        },
      ],
    });
  const postMeta = (body: unknown) => {
    const { raw, sig } = signed(body);
    return http()
      .post(`/webhooks/whatsapp/${metaChannel}`)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sig)
      .send(raw);
  };
  const outbox = (type: string) =>
    db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(eq(eventsSchema.outbox.tenantId, tenantA), eq(eventsSchema.outbox.eventType, type)),
      );

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString()));
      req.on('end', () => {
        calls.push({
          path: req.url ?? '',
          headers: req.headers,
          body: JSON.parse(data || '{}') as Record<string, unknown>,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [{ id: `wamid.OUT${calls.length}` }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    providerBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_comms_msg'),
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
            new EnvSecretProvider({
              COMMS_OTP_HMAC_KEY: 'test-otp-key',
              META_CRED: JSON.stringify(META),
              D360_CRED: JSON.stringify(D360),
              FAKE_SECRET: 'fake-secret',
            }),
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
          stages: [IntegrationsModule.capabilityStage()],
        }),
        OrganizationModule,
        IntegrationsModule,
        GuestModule,
        FakeIdentityModule,
        OperationsModule,
        CommunicationsModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false, rawBody: true });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    app.get(ChannelAdapterRegistry).register(sms);

    tenantA = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `ms-a-${stamp}`, name: 'A' })
        .expect(201)
    ).body.id;
    tenantB = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `ms-b-${stamp}`, name: 'B' })
        .expect(201)
    ).body.id;
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({
          code: 'MSG',
          name: 'Nile Palace',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
          country: 'EG',
        })
        .expect(201)
    ).body.id;
    const tree = await http().get(`${base()}/locations`).set('X-Test-Actor', gm()).expect(200);
    const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
    room504 = (
      await http()
        .post(`${base()}/rooms`)
        .set('X-Test-Actor', gm())
        .send({ parentId: root, roomNumber: '504' })
        .expect(201)
    ).body.locationId;
    metaChannel = (
      await http()
        .post(`${base()}/channels`)
        .set('X-Test-Actor', gm())
        .send({
          type: 'WHATSAPP',
          name: 'WhatsApp (Meta)',
          providerCode: 'WHATSAPP_META_CLOUD',
          config: {
            phoneNumberId: '1234567890',
            graphBaseUrl: providerBase,
            templates: {
              otp: { name: 'hotella_otp', codeButton: true },
              activation: { name: 'hotella_activation' },
            },
          },
          credentialRef: 'env://META_CRED',
        })
        .expect(201)
    ).body.id;
    await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'SMS',
        name: 'SMS',
        providerCode: 'FAKE_SMS',
        credentialRef: 'env://FAKE_SECRET',
      })
      .expect(201);

    mona = newId();
    stayId = newId();
    const today = new Date().toISOString().slice(0, 10);
    const departure = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await db.execute(
      sql`insert into guest.guests (id, tenant_id, given_name, family_name, primary_locale) values (${mona}, ${tenantA}, 'Mona', 'Delta', 'ar')`,
    );
    await db.execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, actual_checkin_at, last_pms_event_at)
      values (${stayId}, ${tenantA}, ${propertyA}, 'IN_HOUSE', ${mona}, ${today}, ${departure}, now(), now())`);
    await db.execute(
      sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at) values (${newId()}, ${tenantA}, ${stayId}, ${mona}, 'PRIMARY', now())`,
    );
    await db.execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
      values (${newId()}, ${tenantA}, ${propertyA}, ${stayId}, ${room504}, now(), 'INITIAL')`);
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('activation with the Meta Cloud API adapter: the code leaves as an authentication template', async () => {
    const link = await http()
      .post(`${base()}/stays/${stayId}/activation-tokens`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(201);
    const activation = app.get(ActivationService);
    const req = await activation.requestOtp({ token: link.body.token, phone: MONA }, 'ar');
    expect(req.sentVia).toBe('WHATSAPP');
    const call = calls.at(-1)!;
    expect(call.path).toBe('/v23.0/1234567890/messages');
    expect(call.headers.authorization).toBe(`Bearer ${META.accessToken}`);
    const template = call.body.template as {
      name: string;
      components: Array<{ parameters: Array<{ text: string }> }>;
    };
    expect(template.name).toBe('hotella_otp');
    const code = template.components[0]!.parameters[0]!.text;
    const done = await activation.verify(req.handle, code, 'phone');
    expect(done.scopes).toContain('CHAT');
    guestSession = done.sessionToken;
    // Meta's subscription handshake.
    const hs = await http()
      .get(`/webhooks/whatsapp/${metaChannel}`)
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': META.verifyToken,
        'hub.challenge': '12345',
      })
      .expect(200);
    expect(hs.text).toBe('12345');
    await http()
      .get(`/webhooks/whatsapp/${metaChannel}`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' })
      .expect(401);
  });

  it('a message from the verified phone lands in the stay conversation, once; forged webhooks store nothing', async () => {
    const body = inbound(MONA, `wamid.IN1-${stamp}`, 'الجو حر أوي هنا');
    expect((await postMeta(body).expect(200)).body).toEqual({ received: 1, stored: 1 });
    expect((await postMeta(body).expect(200)).body).toEqual({ received: 1, stored: 0 });
    const forged = await http()
      .post(`/webhooks/whatsapp/${metaChannel}`)
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=00')
      .send(JSON.stringify(inbound(MONA, `wamid.FORGED-${stamp}`, 'x')))
      .expect(401);
    expect(forged.body.code).toBe('platform.unauthorized');
    await http().post(`/webhooks/whatsapp/${newId()}`).send({}).expect(404);

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.stayId, stayId));
    expect(conversation).toMatchObject({
      guestId: mona,
      status: 'WAITING_STAFF',
      replyChannelId: metaChannel,
    });
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation!.id));
    expect(msgs.map((m) => [m.direction, m.body])).toEqual([['INBOUND', 'الجو حر أوي هنا']]);
    expect(await outbox('comms.message.received')).toHaveLength(1);
    expect(await outbox('comms.conversation.opened')).toHaveLength(1);
  });

  it('an unverified phone gets its own conversation and the activation prompt — never the stay', async () => {
    await postMeta(inbound(STRANGER, `wamid.IN2-${stamp}`, 'I am in room 504, send towels')).expect(
      200,
    );
    const [c] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantA), sql`${conversations.stayId} is null`));
    expect(c).toMatchObject({ guestId: null, stayId: null });
    const before = calls.length;
    await app.get(ConversationService).sendDue();
    const prompt = calls
      .slice(before)
      .find((x) => (x.body as { to?: string }).to === STRANGER.slice(1))!;
    expect(prompt.body).toMatchObject({ type: 'text' });
    expect(JSON.stringify(prompt.body)).toContain('Nile Palace');
    // A second message the same day does not prompt again.
    await postMeta(inbound(STRANGER, `wamid.IN3-${stamp}`, 'hello?')).expect(200);
    const queued = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, c!.id), eq(messages.senderType, 'SYSTEM')));
    expect(queued).toHaveLength(1);
  });

  it('staff inbox: guest, stay, room and open work beside the thread; reply, receipts, takeover, assign', async () => {
    const ops = app.get<OperationsPublicApi>(OPERATIONS_API);
    ops.registerWorkItemKind({
      code: 'GUEST_COMPLAINT',
      module: 'comms',
      descriptionKey: 'comms.permission.inbox_read',
    });
    await ops.createWorkItem({
      tenantId: tenantA,
      propertyId: propertyA,
      kind: 'GUEST_COMPLAINT',
      source: { module: 'comms', entityType: 'test', entityId: newId() },
      title: { text: 'AC too warm' },
      stayId,
      guestId: mona,
    });
    const list = await http().get(`${base()}/conversations`).set('X-Test-Actor', gm()).expect(200);
    const row = (
      list.body as Array<{
        id: string;
        stay: { room: { number: string } } | null;
        guest: { givenName: string } | null;
      }>
    ).find((c) => c.stay);
    expect(row).toMatchObject({ guest: { givenName: 'Mona' }, stay: { room: { number: '504' } } });
    const detail = await http()
      .get(`${base()}/conversations/${row!.id}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(detail.body.openWork).toEqual([
      expect.objectContaining({ kind: 'GUEST_COMPLAINT', status: 'OPEN' }),
    ]);
    expect(detail.body.aiSummary).toBeNull();

    const reply = await http()
      .post(`${base()}/conversations/${row!.id}/messages`)
      .set('X-Test-Actor', gm())
      .send({ body: 'Sorry about that — engineering is on the way.' })
      .expect(201);
    expect(reply.body.deliveryStatus).toBe('QUEUED');
    const before = calls.length;
    await app.get(ConversationService).sendDue();
    const sent = calls.slice(before).find((x) => (x.body as { to?: string }).to === MONA.slice(1))!;
    expect(sent.body).toMatchObject({
      type: 'text',
      text: { body: 'Sorry about that — engineering is on the way.' },
    });
    const [out] = await db.select().from(messages).where(eq(messages.id, reply.body.id));
    expect(out).toMatchObject({ deliveryStatus: 'SENT' });
    // Receipts move forward only.
    const ts = String(Math.floor(Date.now() / 1000));
    await postMeta(
      cloud({ statuses: [{ id: out!.providerMessageId, status: 'read', timestamp: ts }] }),
    ).expect(200);
    await postMeta(
      cloud({ statuses: [{ id: out!.providerMessageId, status: 'delivered', timestamp: ts }] }),
    ).expect(200);
    expect(
      (await db.select().from(messages).where(eq(messages.id, out!.id)))[0]!.deliveryStatus,
    ).toBe('READ');

    const taken = await http()
      .post(`${base()}/conversations/${row!.id}/takeover`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'VIP guest' })
      .expect(200);
    expect(taken.body).toMatchObject({
      status: 'HANDED_OFF',
      aiMode: 'OFF',
      assignedUserId: staffId,
    });
    expect(await outbox('comms.handoff.requested')).toHaveLength(1);
    await http()
      .post(`${base()}/conversations/${row!.id}/assign`)
      .set('X-Test-Actor', gm())
      .send({ userId: null, version: taken.body.version - 1 })
      .expect(409);
    await http()
      .post(`${base()}/conversations/${row!.id}/assign`)
      .set('X-Test-Actor', gm())
      .send({ userId: null, version: taken.body.version })
      .expect(200);
    await http()
      .get(`${base()}/conversations/${row!.id}`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(404);
  });

  it('guest web writes into the same conversation; replies there need no provider', async () => {
    const view = await http()
      .get('/guest/conversation')
      .set('X-Guest-Session', guestSession)
      .expect(200);
    expect(view.body.messages.map((m: { body: string }) => m.body)).toEqual([
      'الجو حر أوي هنا',
      'Sorry about that — engineering is on the way.',
    ]);
    const posted = await http()
      .post('/guest/conversation/messages')
      .set('X-Guest-Session', guestSession)
      .send({ body: 'Thanks! Also extra pillows please.' })
      .expect(201);
    expect(posted.body.conversationId).toBe(view.body.conversation.id);
    const reply = await http()
      .post(`${base()}/conversations/${posted.body.conversationId}/messages`)
      .set('X-Test-Actor', gm())
      .send({ body: 'Pillows coming up.' })
      .expect(201);
    expect(reply.body.deliveryStatus).toBe('SENT');
  });

  it('the same flow through a BSP adapter (360dialog), webhooks authenticated by the shared secret', async () => {
    const meta = await http()
      .get(`${base()}/channels/${metaChannel}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    await http()
      .patch(`${base()}/channels/${metaChannel}`)
      .set('X-Test-Actor', gm())
      .send({ version: meta.body.version, status: 'DISABLED' })
      .expect(200);
    bspChannel = (
      await http()
        .post(`${base()}/channels`)
        .set('X-Test-Actor', gm())
        .send({
          type: 'WHATSAPP',
          name: 'WhatsApp (360dialog)',
          providerCode: 'WHATSAPP_BSP_360DIALOG',
          config: { baseUrl: providerBase, templates: { otp: { name: 'otp_bsp' } } },
          credentialRef: 'env://D360_CRED',
        })
        .expect(201)
    ).body.id;
    const link = await http()
      .post(`${base()}/stays/${stayId}/activation-tokens`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(201);
    const activation = app.get(ActivationService);
    const phone = '+201223344556';
    const req = await activation.requestOtp({ token: link.body.token, phone }, 'en');
    const call = calls.at(-1)!;
    expect(call.path).toBe('/messages');
    expect(call.headers['d360-api-key']).toBe(D360.apiKey);
    const code = (
      call.body.template as { components: Array<{ parameters: Array<{ text: string }> }> }
    ).components[0]!.parameters[0]!.text;
    expect((await activation.verify(req.handle, code, null)).scopes).toContain('CHAT');
    const raw = JSON.stringify(inbound(phone, `wamid.BSPIN-${stamp}`, 'hello from BSP'));
    await http()
      .post(`/webhooks/whatsapp/${bspChannel}`)
      .set('content-type', 'application/json')
      .set(BSP_WEBHOOK_SECRET_HEADER, 'wrong')
      .send(raw)
      .expect(401);
    await http()
      .post(`/webhooks/whatsapp/${bspChannel}`)
      .set('content-type', 'application/json')
      .set(BSP_WEBHOOK_SECRET_HEADER, D360.webhookSecret)
      .send(raw)
      .expect(200);
    const [c] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.stayId, stayId), sql`${conversations.status} <> 'CLOSED'`));
    expect(c!.replyChannelId).toBe(bspChannel);
  });

  it('replies outside the 24-hour window fail instead of being sent; check-out closes the conversation', async () => {
    const [c] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.stayId, stayId), sql`${conversations.status} <> 'CLOSED'`));
    await db
      .update(conversations)
      .set({
        lastInboundAt: new Date(Date.now() - 25 * 3_600_000),
        replyChannelId: bspChannel,
        replyChannelType: 'WHATSAPP',
      })
      .where(eq(conversations.id, c!.id));
    const reply = await http()
      .post(`${base()}/conversations/${c!.id}/messages`)
      .set('X-Test-Actor', gm())
      .send({ body: 'Late reply' })
      .expect(201);
    await app.get(ConversationService).sendDue();
    expect(
      (await db.select().from(messages).where(eq(messages.id, reply.body.id)))[0],
    ).toMatchObject({ deliveryStatus: 'FAILED', errorCode: 'OUTSIDE_WINDOW' });

    await app.get(ConversationService).apply(
      createEnvelope(StayStatusChanged, {
        eventId: newId(),
        tenantId: tenantA,
        propertyId: propertyA,
        source: 'guest',
        correlationId: null,
        payload: {
          stay_id: stayId,
          primary_guest_id: mona,
          from: 'IN_HOUSE',
          to: 'CHECKED_OUT',
          at: new Date().toISOString(),
          room_id: room504,
        },
      }),
    );
    expect(
      (await db.select().from(conversations).where(eq(conversations.id, c!.id)))[0],
    ).toMatchObject({ status: 'CLOSED', aiMode: 'OFF' });
    // Message history is append-only.
    const dbError = await db
      .execute(sql`delete from comms.messages where conversation_id = ${c!.id}`)
      .then(
        () => 'no error',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
      );
    expect(dbError).toMatch(/append-only/);
  });
});
