import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { createEnvelope, GuestAnonymized } from '@hotella/contracts-events';
import { GuestModule } from '@hotella/domain-guest';
import { IntegrationsModule } from '@hotella/domain-integrations';
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
  TransactionRunner,
} from '@hotella/platform-database';
import { EventsModule, IdempotentConsumer } from '@hotella/platform-events';
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
import { ChannelRuntime } from './application/channel.service';
import { FakeSmsProvider, FakeWhatsAppProvider } from './application/fake-providers';
import { GuestLifecycleConsumer } from './application/guest-lifecycle';
import { ChannelIdentityService } from './application/identity.service';
import { ChannelAdapterRegistry } from './application/providers';
import { CommunicationsModule, GUEST_LIFECYCLE_CONSUMER } from './communications.module';
import { CommsRepositories } from './infrastructure/repositories';
import { channelIdentities } from './infrastructure/schema';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const PERMS = ['org.property.read', 'org.property.manage', 'channel.manage'];

describe.skipIf(needsInfra())(`Communications against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  const whatsapp = new FakeWhatsAppProvider();
  const sms = new FakeSmsProvider();
  const grants: Record<string, string[]> = {
    gm: PERMS,
    other: PERMS,
    clerk: ['org.property.read'],
  };
  const http = () => request(app.getHttpServer());
  const gm = () => user('gm', tenantA);
  const base = () => `/properties/${propertyA}`;

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_comms'),
      VALKEY_URL: 'redis://127.0.0.1:1',
    };
    const ref = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ env }),
        ObservabilityModule.forRoot(),
        I18nModule.forRoot(),
        SecretsModule.forRoot({
          providers: [new EnvSecretProvider({ FAKE_WA_SECRET: 'wa-shared-secret' })],
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
        CommunicationsModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    app.get(ChannelAdapterRegistry).register(whatsapp, sms);

    tenantA = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `cm-a-${stamp}`, name: 'A' })
        .expect(201)
    ).body.id;
    tenantB = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `cm-b-${stamp}`, name: 'B' })
        .expect(201)
    ).body.id;
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({ code: 'CMA', name: 'Comms A', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id;
  });
  afterAll(() => app?.close());

  it('binds channels to registered provider adapters with a SecretRef, never a secret', async () => {
    const created = await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'WHATSAPP',
        name: 'Guest WhatsApp',
        providerCode: 'FAKE_WHATSAPP',
        config: { phoneNumberId: '123' },
        credentialRef: 'env://FAKE_WA_SECRET',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      type: 'WHATSAPP',
      status: 'ACTIVE',
      health: 'HEALTHY',
      version: 1,
    });
    // A raw secret, an unknown adapter or an adapter of another channel type is refused.
    await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'WHATSAPP',
        name: 'Raw',
        providerCode: 'FAKE_WHATSAPP',
        credentialRef: 'EAAG-raw-token',
      })
      .expect(400);
    const unknown = await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'WHATSAPP',
        name: 'X',
        providerCode: 'NOPE',
        credentialRef: 'env://FAKE_WA_SECRET',
      })
      .expect(422);
    expect(unknown.body.code).toBe('comms.channel.unknown_provider');
    await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'WHATSAPP',
        name: 'Y',
        providerCode: 'FAKE_SMS',
        credentialRef: 'env://FAKE_WA_SECRET',
      })
      .expect(422);
    const dup = await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'SMS',
        name: 'Guest WhatsApp',
        providerCode: 'FAKE_SMS',
        credentialRef: 'env://FAKE_WA_SECRET',
      })
      .expect(409);
    expect(dup.body.code).toBe('comms.channel.name_taken');
    await http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'SMS',
        name: 'SMS fallback',
        providerCode: 'FAKE_SMS',
        credentialRef: 'env://FAKE_WA_SECRET',
      })
      .expect(201);

    const list = await http().get(`${base()}/channels`).set('X-Test-Actor', gm()).expect(200);
    // Listed by channel type (enum order), then name.
    expect((list.body as Array<{ type: string }>).map((c) => c.type)).toEqual(['WHATSAPP', 'SMS']);

    // The runtime resolves credentials lazily through the SecretProvider.
    const row = await app
      .get(CommsRepositories)
      .channel({ tenantId: tenantA, propertyId: propertyA }, created.body.id);
    const ctx = app.get(ChannelRuntime).context(row!);
    expect(await ctx.credential()).toBe('wa-shared-secret');
    expect(
      await app
        .get(ChannelRuntime)
        .adapterFor(row!)
        .verifyWebhook(ctx, {
          rawBody: Buffer.from('{}'),
          headers: { 'x-fake-signature': 'wa-shared-secret' },
        }),
    ).toBe(true);
  });

  it('updates with optimistic versions; other tenants and staff without the permission are kept out', async () => {
    const [ch] = (await http().get(`${base()}/channels`).set('X-Test-Actor', gm()).expect(200))
      .body as Array<{
      id: string;
      version: number;
    }>;
    const updated = await http()
      .patch(`${base()}/channels/${ch!.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: ch!.version, status: 'DISABLED' })
      .expect(200);
    expect(updated.body).toMatchObject({ status: 'DISABLED', version: ch!.version + 1 });
    const stale = await http()
      .patch(`${base()}/channels/${ch!.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: ch!.version, status: 'ACTIVE' })
      .expect(409);
    expect(stale.body.code).toBe('comms.channel.version_conflict');
    await http()
      .get(`${base()}/channels/${ch!.id}`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(404);
    await http().get(`${base()}/channels`).set('X-Test-Actor', user('clerk', tenantA)).expect(403);
    await http().get(`${base()}/channels/not-a-uuid`).set('X-Test-Actor', gm()).expect(404);
  });

  it('channel identities: observed, verified for a guest, forgotten when the guest is anonymized', async () => {
    const identities = app.get(ChannelIdentityService);
    const tx = app.get(TransactionRunner);
    // A guest row is needed for the foreign key; the guest context owns it, so it is inserted directly here.
    const guestId = newId();
    await db.execute(
      sql`insert into guest.guests (id, tenant_id, given_name) values (${guestId}, ${tenantA}, 'Nour')`,
    );
    const phone = '+201001234567';
    const seen = await tx.run(() => identities.observe(tenantA, 'WHATSAPP', phone));
    expect(seen).toMatchObject({ guestId: null, verifiedAt: null });
    expect(await identities.verified(tenantA, 'WHATSAPP', phone)).toBeNull();
    await tx.run(() => identities.verify(tenantA, 'WHATSAPP', phone, guestId));
    expect((await identities.verified(tenantA, 'WHATSAPP', phone))?.guestId).toBe(guestId);
    expect(
      (await identities.verifiedOfGuest(tenantA, guestId, 'WHATSAPP'))?.identifierNormalized,
    ).toBe(phone);
    // Observing again keeps one row and the verification.
    await tx.run(() => identities.observe(tenantA, 'WHATSAPP', phone));
    const rows = await db
      .select()
      .from(channelIdentities)
      .where(eq(channelIdentities.tenantId, tenantA));
    expect(rows).toHaveLength(1);
    // The same number in another tenant is another identity.
    expect(await identities.verified(tenantB, 'WHATSAPP', phone)).toBeNull();

    const once = app.get(IdempotentConsumer);
    const lifecycle = app.get(GuestLifecycleConsumer);
    const envelope = createEnvelope(GuestAnonymized, {
      eventId: newId(),
      tenantId: tenantA,
      propertyId: null,
      source: 'guest',
      correlationId: null,
      payload: { guest_id: guestId },
    });
    await once.once(GUEST_LIFECYCLE_CONSUMER, envelope, (e) => lifecycle.apply(e));
    expect(await identities.verified(tenantA, 'WHATSAPP', phone)).toBeNull();
    expect(
      await db.select().from(channelIdentities).where(eq(channelIdentities.tenantId, tenantA)),
    ).toHaveLength(0);
  });
});
