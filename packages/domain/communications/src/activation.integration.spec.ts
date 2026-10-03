import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { createEnvelope, StayStatusChanged } from '@hotella/contracts-events';
import { GuestModule } from '@hotella/domain-guest';
import { IDENTITY_API } from '@hotella/domain-identity/public';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { OperationsModule, operationsSchema } from '@hotella/domain-operations';
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivationService } from './application/activation.service';
import { ArrivalActivation } from './application/arrival-activation';
import { FakeSmsProvider, FakeWhatsAppProvider } from './application/fake-providers';
import { ChannelIdentityService } from './application/identity.service';
import { ChannelAdapterRegistry, ProviderError } from './application/providers';
import { CommunicationsModule } from './communications.module';
import { channels, verificationDeliveries, verificationSessions } from './infrastructure/schema';

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
  'guest.activation.assist',
  'qr.manage',
];
const MONA_PHONE = '+201001234567';

/** Operations looks staff up through identity; nobody is notified in these tests. */
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

describe.skipIf(needsInfra())(`Guest activation against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let activation: ActivationService;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  let stayId: string;
  let mona: string;
  let ali: string;
  let whatsappChannel: string;
  const rooms: Record<string, string> = {};
  const whatsapp = new FakeWhatsAppProvider();
  const sms = new FakeSmsProvider();
  const grants: Record<string, string[]> = { [staffId]: PERMS, gm: PERMS, other: PERMS };
  const http = () => request(app.getHttpServer());
  const gm = () => user(staffId, tenantA);
  const base = () => `/properties/${propertyA}`;
  const lastCode = (p: FakeWhatsAppProvider | FakeSmsProvider) => {
    const m = p.sent.at(-1)!;
    return m.parameters?.[0] ?? /\b(\d{6})\b/.exec(m.text ?? '')![1]!;
  };
  const issue = async (guestId?: string) =>
    (
      await http()
        .post(`${base()}/stays/${stayId}/activation-tokens`)
        .set('X-Test-Actor', gm())
        .send(guestId ? { guestId } : {})
        .expect(201)
    ).body as { id: string; token: string; url: string };
  const deliveriesOf = async (handleSessionPhone: string) =>
    db
      .select({
        channel: verificationDeliveries.channel,
        status: verificationDeliveries.status,
        trigger: verificationDeliveries.trigger,
      })
      .from(verificationDeliveries)
      .innerJoin(
        verificationSessions,
        eq(verificationSessions.id, verificationDeliveries.sessionId),
      )
      .where(
        and(
          eq(verificationSessions.tenantId, tenantA),
          eq(verificationSessions.phoneNormalized, handleSessionPhone),
        ),
      )
      .orderBy(verificationDeliveries.id);

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_comms_act'),
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
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    activation = app.get(ActivationService);
    app.get(ChannelAdapterRegistry).register(whatsapp, sms);

    tenantA = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `ac-a-${stamp}`, name: 'A' })
        .expect(201)
    ).body.id;
    tenantB = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `ac-b-${stamp}`, name: 'B' })
        .expect(201)
    ).body.id;
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({
          code: 'ACT',
          name: 'Red Sea Resort',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
          country: 'EG',
        })
        .expect(201)
    ).body.id;
    const tree = await http().get(`${base()}/locations`).set('X-Test-Actor', gm()).expect(200);
    const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
    for (const n of ['504', '505'])
      rooms[n] = (
        await http()
          .post(`${base()}/rooms`)
          .set('X-Test-Actor', gm())
          .send({ parentId: root, roomNumber: n })
          .expect(201)
      ).body.locationId;
    for (const [type, name, providerCode] of [
      ['WHATSAPP', 'WhatsApp', 'FAKE_WHATSAPP'],
      ['SMS', 'SMS', 'FAKE_SMS'],
    ] as const) {
      const r = await http()
        .post(`${base()}/channels`)
        .set('X-Test-Actor', gm())
        .send({ type, name, providerCode, credentialRef: 'env://FAKE_SECRET' })
        .expect(201);
      if (type === 'WHATSAPP') whatsappChannel = r.body.id;
    }

    // An in-house stay in room 504, as the guest context projects it from the PMS (rows written directly here).
    mona = newId();
    ali = newId();
    stayId = newId();
    await db.execute(sql`insert into guest.guests (id, tenant_id, given_name, family_name, primary_locale)
      values (${mona}, ${tenantA}, 'Mona', 'Delta', 'ar'), (${ali}, ${tenantA}, 'Ali', 'Delta', 'en')`);
    await db.execute(sql`insert into guest.guest_identifiers (id, tenant_id, guest_id, kind, value_normalized, source)
      values (${newId()}, ${tenantA}, ${mona}, 'PHONE', '+20 100 123 4567', 'PMS')`);
    const today = new Date().toISOString().slice(0, 10);
    const departure = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await db.execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, actual_checkin_at, last_pms_event_at)
      values (${stayId}, ${tenantA}, ${propertyA}, 'IN_HOUSE', ${mona}, ${today}, ${departure}, now(), now())`);
    await db.execute(sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at)
      values (${newId()}, ${tenantA}, ${stayId}, ${mona}, 'PRIMARY', now()), (${newId()}, ${tenantA}, ${stayId}, ${ali}, 'ACCOMPANYING', now())`);
    await db.execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
      values (${newId()}, ${tenantA}, ${propertyA}, ${stayId}, ${rooms['504']}, now(), 'INITIAL')`);
  });
  afterAll(() => app?.close());
  beforeEach(() => {
    whatsapp.reset();
    sms.reset();
  });

  it('link → phone → WhatsApp code → grant and session; the guest is then known without questions', async () => {
    const link = await issue();
    expect(link.url).toBe(`https://guest.example.test/a/${link.token}`);
    const start = await http()
      .post('/guest/activation/start')
      .send({ token: link.token })
      .expect(200);
    expect(start.body).toMatchObject({ propertyId: propertyA, propertyName: 'Red Sea Resort' });

    const req = await http()
      .post('/guest/activation/otp/request')
      .set('Accept-Language', 'ar')
      .send({ token: link.token, phone: '0100 123 4567' })
      .expect(200);
    expect(req.body).toMatchObject({ sentVia: 'WHATSAPP' });
    expect(req.body.reference).toMatch(/^[A-Z2-9]{6}$/);
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({
      to: MONA_PHONE,
      template: 'otp',
      channelId: whatsappChannel,
    });
    const code = lastCode(whatsapp);

    const wrong = await http()
      .post('/guest/activation/otp/verify')
      .send({ handle: req.body.handle, code: code === '000000' ? '111111' : '000000' })
      .expect(400);
    expect(wrong.body.code).toBe('comms.otp.invalid');
    const ok = await http()
      .post('/guest/activation/otp/verify')
      .send({ handle: req.body.handle, code, device: 'iPhone' })
      .expect(200);
    expect(ok.body.scopes).toContain('VIEW_BILL');

    const me = await http()
      .get('/guest/me')
      .set('X-Guest-Session', ok.body.sessionToken)
      .expect(200);
    expect(me.body).toMatchObject({
      guest: { givenName: 'Mona' },
      stay: { id: stayId, status: 'IN_HOUSE', room: { number: '504' } },
      property: { id: propertyA, name: 'Red Sea Resort' },
    });
    // Single use: the link is spent, and the verified session cannot mint a second guest session.
    await http().post('/guest/activation/start').send({ token: link.token }).expect(410);
    await http()
      .post('/guest/activation/otp/request')
      .send({ token: link.token, phone: MONA_PHONE })
      .expect(410);
    await http().post('/guest/activation/complete').send({ handle: req.body.handle }).expect(410);
    expect(
      (await app.get(ChannelIdentityService).verified(tenantA, 'WHATSAPP', MONA_PHONE))?.guestId,
    ).toBe(mona);

    // Sign-out ends the session; unknown or missing sessions get one generic 401.
    await http().post('/guest/logout').set('X-Guest-Session', ok.body.sessionToken).expect(200);
    await http().get('/guest/me').set('X-Guest-Session', ok.body.sessionToken).expect(401);
    await http().get('/guest/me').expect(401);
  });

  it('a WhatsApp error moves the same code to SMS; the attempt counter is one across channels', async () => {
    whatsapp.failWith = new ProviderError('REJECTED', false);
    const link = await issue(ali);
    const phone = '+201112223334';
    const req = await activation.requestOtp({ token: link.token, phone }, 'en');
    expect(req.sentVia).toBe('SMS');
    expect(sms.sent[0]!.text).toContain('Red Sea Resort');
    const code = lastCode(sms);
    await expect(
      activation.verify(req.handle, code === '000000' ? '111111' : '000000', null),
    ).rejects.toMatchObject({
      code: 'comms.otp.invalid',
      params: { remaining: 4 },
    });
    expect((await deliveriesOf(phone)).map((d) => [d.channel, d.status, d.trigger])).toEqual([
      ['WHATSAPP', 'FAILED', 'INITIAL'],
      ['SMS', 'SENT', 'AUTO_FALLBACK'],
    ]);
    // Asking again right away is refused until the manual-fallback delay passed.
    await expect(activation.resend(req.handle)).rejects.toMatchObject({
      code: 'comms.otp.resend_too_early',
    });
    const done = await activation.verify(req.handle, code, null);
    // The token named Ali, the companion: narrower scopes (no bill).
    expect(done.scopes).toContain('ROOM_CONTROL');
    expect(done.scopes).not.toContain('VIEW_BILL');
  });

  it('no receipt within the timeout: the sweep sends the same code by SMS; a receipt stops it', async () => {
    const phone = '+201223334445';
    const req = await activation.requestOtp({ token: (await issue()).token, phone }, 'en');
    expect(req.sentVia).toBe('WHATSAPP');
    const code = lastCode(whatsapp);
    // The sweep covers every open session; only this phone's messages are asserted.
    const toPhone = () => sms.sent.filter((m) => m.to === phone);
    await activation.sweepFallbacks(new Date(Date.now() + 5_000));
    expect(toPhone()).toHaveLength(0);
    await activation.sweepFallbacks(new Date(Date.now() + 21_000));
    expect(toPhone()).toHaveLength(1);
    expect(/\b(\d{6})\b/.exec(toPhone()[0]!.text!)![1]).toBe(code);
    await activation.sweepFallbacks(new Date(Date.now() + 60_000));
    expect(toPhone()).toHaveLength(1);

    // With a delivery receipt there is no fallback.
    const phone2 = '+201334445556';
    await activation.requestOtp({ token: (await issue()).token, phone: phone2 }, 'en');
    const ref = whatsapp.sent.at(-1)!.providerMessageId;
    expect(
      await activation.deliveryStatus(tenantA, whatsappChannel, ref, 'DELIVERED', new Date()),
    ).toBe(true);
    await activation.sweepFallbacks(new Date(Date.now() + 30_000));
    expect(sms.sent.filter((m) => m.to === phone2)).toHaveLength(0);
    // Receipts only move forward.
    expect(await activation.deliveryStatus(tenantA, whatsappChannel, ref, 'SENT', new Date())).toBe(
      false,
    );
  });

  it('an offline WhatsApp channel sends codes straight to SMS and raises one deduplicated alert', async () => {
    whatsapp.failWith = new ProviderError('UNAVAILABLE', true);
    await activation.requestOtp({ token: (await issue()).token, phone: '+201445556667' }, 'en'); // DEGRADED
    await activation.requestOtp({ token: (await issue()).token, phone: '+201445556668' }, 'en'); // OFFLINE
    const [ch] = await db.select().from(channels).where(eq(channels.id, whatsappChannel));
    expect(ch!.health).toBe('OFFLINE');
    whatsapp.reset();
    const third = await activation.requestOtp(
      { token: (await issue()).token, phone: '+201445556669' },
      'en',
    );
    expect(third.sentVia).toBe('SMS');
    expect(whatsapp.sent).toHaveLength(0);
    expect((await deliveriesOf('+201445556669')).map((d) => d.channel)).toEqual(['SMS']);
    const alerts = await db
      .select()
      .from(operationsSchema.alerts)
      .where(
        and(
          eq(operationsSchema.alerts.tenantId, tenantA),
          eq(operationsSchema.alerts.dedupeKey, `comms.channel.unhealthy:${whatsappChannel}`),
        ),
      );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.occurrences).toBeGreaterThanOrEqual(2);
    // New credentials give the channel a fresh chance.
    await http()
      .patch(`${base()}/channels/${whatsappChannel}`)
      .set('X-Test-Actor', gm())
      .send({ version: ch!.version, credentialRef: 'env://FAKE_SECRET' })
      .expect(200);
  });

  it('brute force locks the session; the per-phone limit stops floods', async () => {
    const req = await activation.requestOtp(
      { token: (await issue()).token, phone: '+201556667778' },
      'en',
    );
    const code = lastCode(whatsapp);
    const bad = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++)
      await expect(activation.verify(req.handle, bad, null)).rejects.toMatchObject({
        code: 'comms.otp.invalid',
      });
    await expect(activation.verify(req.handle, bad, null)).rejects.toMatchObject({
      code: 'comms.otp.locked',
    });
    await expect(activation.verify(req.handle, code, null)).rejects.toMatchObject({
      code: 'comms.otp.locked',
    });

    const phone = '+201667778889';
    for (let i = 0; i < 5; i++)
      await activation.requestOtp({ token: (await issue()).token, phone }, 'en');
    await expect(
      activation.requestOtp({ token: (await issue()).token, phone }, 'en'),
    ).rejects.toMatchObject({
      code: 'comms.otp.too_many_requests',
    });
    await expect(
      activation.requestOtp({ token: (await issue()).token, phone: '12345' }, 'en'),
    ).rejects.toMatchObject({
      code: 'comms.otp.invalid_phone',
    });
  });

  it('room QR: opaque token → room; last name + phone + code → access; rotation invalidates the printed code', async () => {
    const gen = await http()
      .post(`${base()}/rooms/${rooms['504']}/qr-code`)
      .set('X-Test-Actor', gm())
      .expect(201);
    expect(gen.body.url).toBe(`https://guest.example.test/q/${gen.body.token}`);
    expect(gen.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const resolved = await http().get(`/guest/qr/${gen.body.token}`).expect(200);
    expect(resolved.body).toEqual({
      propertyId: propertyA,
      propertyName: 'Red Sea Resort',
      roomNumber: '504',
    });
    const miss = await http()
      .post(`/guest/qr/${gen.body.token}/verify`)
      .send({ lastName: 'Nile' })
      .expect(422);
    expect(miss.body.code).toBe('comms.qr.no_match');
    await http().post(`/guest/qr/${gen.body.token}/verify`).send({ lastName: 'delta' }).expect(200);
    const req = await activation.requestOtp(
      { qrToken: gen.body.token, lastName: 'DELTA', phone: '+201778889990' },
      'en',
    );
    const done = await activation.verify(req.handle, lastCode(whatsapp), null);
    expect(done.scopes).toContain('VIEW_BILL');
    // An empty room never matches.
    const r505 = await http()
      .post(`${base()}/rooms/${rooms['505']}/qr-code`)
      .set('X-Test-Actor', gm())
      .expect(201);
    await http()
      .post(`/guest/qr/${r505.body.token}/verify`)
      .send({ lastName: 'Delta' })
      .expect(422);

    const rotated = await http()
      .post(`${base()}/rooms/${rooms['504']}/qr-code`)
      .set('X-Test-Actor', gm())
      .expect(201);
    await http().get(`/guest/qr/${gen.body.token}`).expect(404);
    await http().get(`/guest/qr/${rotated.body.token}`).expect(200);
    const list = await http().get(`${base()}/room-qr-codes`).set('X-Test-Actor', gm()).expect(200);
    expect(
      (list.body as Array<{ roomNumber: string; status: string }>)
        .filter((q) => q.roomNumber === '504')
        .map((q) => q.status),
    ).toEqual(['ACTIVE', 'ROTATED']);
    expect(JSON.stringify(list.body)).not.toContain(rotated.body.token);
    await http()
      .post(`${base()}/rooms/${rooms['504']}/qr-code/revoke`)
      .set('X-Test-Actor', gm())
      .expect(200);
    await http().get(`/guest/qr/${rotated.body.token}`).expect(404);
  });

  it('staff-assisted verification when no code arrives (reason audited), then the guest completes', async () => {
    whatsapp.failWith = new ProviderError('UNAVAILABLE', true);
    sms.failWith = new ProviderError('UNAVAILABLE', true);
    const req = await activation.requestOtp(
      { token: (await issue()).token, phone: '+201889990001' },
      'en',
    );
    expect(req.sentVia).toBeNull();
    await http().post('/guest/activation/complete').send({ handle: req.handle }).expect(409);
    const found = await http()
      .get(`${base()}/verification-sessions?reference=${req.reference}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(found.body).toHaveLength(1);
    expect(found.body[0]).toMatchObject({ phone: '+20*******001', guest: { givenName: 'Mona' } });
    await http()
      .post(`${base()}/verification-sessions/${found.body[0].id}/assist`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'Passport checked at the desk' })
      .expect(200);
    const done = await http()
      .post('/guest/activation/complete')
      .send({ handle: req.handle, device: 'Android' })
      .expect(200);
    await http().get('/guest/me').set('X-Guest-Session', done.body.sessionToken).expect(200);
    const audit = await db.execute<{ reason: string }>(
      sql`select reason from audit.audit_log where action = 'comms.verification.assist' and tenant_id = ${tenantA}`,
    );
    expect(audit.rows.map((r) => r.reason)).toEqual(['Passport checked at the desk']);
    // Another tenant cannot see or act on this property.
    await http()
      .get(`${base()}/verification-sessions?reference=${req.reference}`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(404);
    await http()
      .post(`${base()}/stays/${stayId}/activation-tokens`)
      .set('X-Test-Actor', user('other', tenantB))
      .send({})
      .expect(404);
  });

  it('on arrival, a guest with a verified WhatsApp number receives the activation link', async () => {
    const envelope = createEnvelope(StayStatusChanged, {
      eventId: newId(),
      tenantId: tenantA,
      propertyId: propertyA,
      source: 'guest',
      correlationId: null,
      payload: {
        stay_id: stayId,
        primary_guest_id: mona,
        from: 'EXPECTED',
        to: 'IN_HOUSE',
        at: new Date().toISOString(),
        room_id: rooms['504']!,
      },
    });
    await app.get(ArrivalActivation).apply(envelope);
    expect(whatsapp.sent).toHaveLength(1);
    // Sent to the number Mona verified most recently (staff-assisted above).
    const latest = await app.get(ChannelIdentityService).verifiedOfGuest(tenantA, mona, 'WHATSAPP');
    expect(whatsapp.sent[0]).toMatchObject({
      to: latest!.identifierNormalized,
      template: 'activation',
    });
    const url = whatsapp.sent[0]!.parameters![1]!;
    expect(url).toMatch(/^https:\/\/guest\.example\.test\/a\//);
    await http()
      .post('/guest/activation/start')
      .send({ token: url.split('/a/')[1] })
      .expect(200);
  });
});
