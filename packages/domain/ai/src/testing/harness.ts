import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { ENTITLEMENT_API, USAGE_API, type UsageRecord } from '@hotella/domain-licensing/public';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { CatalogModule } from '@hotella/domain-catalog';
import { CommunicationsModule } from '@hotella/domain-communications';
import { GuestModule } from '@hotella/domain-guest';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
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
import { ObservabilityModule } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AiModule } from '../ai.module';
import { AGENT_DEFINITIONS } from '../application/agent-catalog';
import { CONCIERGE_AGENT } from '../application/concierge.runtime';
import type { BuiltInAgent } from '../domain/agents';

/** Test-only composition of the AI context with the contexts its tools act through (no worker processes). */

export const ADMIN = JSON.stringify({
  type: 'USER',
  id: 'admin',
  tenantId: null,
  isPlatformAdmin: true,
});
export const staff = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

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

/**
 * The licensing context as these tests see it (Spec §58, §61): every capability entitled unless `entitled` names the
 * ones that are; usage records kept in memory; `room` false = a HARD token limit used up.
 */
export const LICENSING = {
  entitled: null as ReadonlySet<string> | null,
  room: true,
  usage: [] as UsageRecord[],
};

@Global()
@Module({
  providers: [
    {
      provide: ENTITLEMENT_API,
      useValue: {
        can: async (_t: string, _p: string | null, code: string) =>
          LICENSING.entitled === null || LICENSING.entitled.has(code),
        entitledUntil: async () => null,
        effective: async () => [],
        assertWithinLimit: async () => undefined,
      },
    },
    {
      provide: USAGE_API,
      useValue: {
        record: async (r: UsageRecord) => {
          if (LICENSING.usage.some((u) => u.idempotencyKey === r.idempotencyKey)) return false;
          LICENSING.usage.push(r);
          return true;
        },
        withinLimit: async () => LICENSING.room,
      },
    },
  ],
  exports: [ENTITLEMENT_API, USAGE_API],
})
class FakeLicensingModule {}

export interface AiHarness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly http: () => ReturnType<typeof request>;
  /** Feature flags of the test (kill switches): set a key to true to switch that path off. */
  readonly flags: Map<string, boolean>;
}

export async function startAiApp(
  url: string,
  role: string,
  grants: Record<string, readonly string[]>,
  options: {
    readonly definitions?: readonly BuiltInAgent[];
    /** The agent the concierge runtime runs (default GUEST_CONCIERGE). */
    readonly conciergeAgent?: string;
  } = {},
): Promise<AiHarness> {
  await runMigrations(url);
  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: await applicationRoleUrl(url, role),
    VALKEY_URL: 'redis://127.0.0.1:1',
    PUBLIC_BASE_URL: 'https://guest.example.test',
  };
  const flags = new Map<string, boolean>();
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ env }),
      ObservabilityModule.forRoot(),
      I18nModule.forRoot(),
      SecretsModule.forRoot({
        providers: [new EnvSecretProvider({ CLOUD_KEY: 'k', COMMS_OTP_HMAC_KEY: 'test-otp-key' })],
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
        resolver: { provide: PERMISSION_RESOLVER, useValue: new StaticPermissionResolver(grants) },
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
      FakeLicensingModule,
      AiModule,
    ],
  })
    .overrideProvider(FeatureFlagService)
    .useValue({ isEnabled: async (key: string) => flags.get(key) ?? false });
  if (options.definitions)
    builder.overrideProvider(AGENT_DEFINITIONS).useValue(options.definitions);
  if (options.conciergeAgent)
    builder.overrideProvider(CONCIERGE_AGENT).useValue(options.conciergeAgent);
  const ref = await builder.compile();
  const app = ref.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  return { app, db: app.get(DATABASE), http: () => request(app.getHttpServer()), flags };
}

export interface Hotel {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly stayId: string;
  readonly guestId: string;
  readonly roomId: string;
}

/**
 * A tenant with one property (Cairo), HK/ENG/FO departments, room 504, the starter catalog and an in-house stay of
 * one guest (rows written the way the PMS projection writes them).
 */
export async function createHotel(h: AiHarness, code: string, gmId: string): Promise<Hotel> {
  const tenantId = (
    await h
      .http()
      .post('/tenants')
      .set('X-Test-Actor', ADMIN)
      .send({ code, name: code })
      .expect(201)
  ).body.id as string;
  const gm = staff(gmId, tenantId);
  const propertyId = (
    await h
      .http()
      .post('/properties')
      .set('X-Test-Actor', gm)
      .send({ code: 'AIT', name: 'Nile View', timezone: 'Africa/Cairo', currency: 'EGP' })
      .expect(201)
  ).body.id as string;
  const base = `/properties/${propertyId}`;
  for (const [dept, name] of [
    ['HK', 'Housekeeping'],
    ['ENG', 'Engineering'],
    ['FO', 'Front office'],
  ])
    await h
      .http()
      .post(`${base}/departments`)
      .set('X-Test-Actor', gm)
      .send({ code: dept, translations: [{ locale: 'en', name }] })
      .expect(201);
  const tree = await h.http().get(`${base}/locations`).set('X-Test-Actor', gm).expect(200);
  const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
  const roomId = (
    await h
      .http()
      .post(`${base}/rooms`)
      .set('X-Test-Actor', gm)
      .send({ parentId: root, roomNumber: '504' })
      .expect(201)
  ).body.locationId as string;
  await h.http().post(`${base}/catalog/starter`).set('X-Test-Actor', gm).send({}).expect(200);
  const guestId = newId();
  const stayId = newId();
  const today = new Date().toISOString().slice(0, 10);
  const departure = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await h.db
    .execute(sql`insert into guest.guests (id, tenant_id, given_name, family_name, primary_locale)
    values (${guestId}, ${tenantId}, 'Mona', 'Delta', 'ar')`);
  await h.db
    .execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, actual_checkin_at, last_pms_event_at)
    values (${stayId}, ${tenantId}, ${propertyId}, 'IN_HOUSE', ${guestId}, ${today}, ${departure}, now(), now())`);
  await h.db
    .execute(sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at)
    values (${newId()}, ${tenantId}, ${stayId}, ${guestId}, 'PRIMARY', now())`);
  await h.db
    .execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
    values (${newId()}, ${tenantId}, ${propertyId}, ${stayId}, ${roomId}, now(), 'INITIAL')`);
  return { tenantId, propertyId, stayId, guestId, roomId };
}

/** A guest web session for the hotel's guest (staff-verified grant), for the guest chat routes. */
export async function guestToken(h: AiHarness, hotel: Hotel): Promise<string> {
  const guests = h.app.get<GuestPublicApi>(GUEST_API);
  const grant = await guests.issueGrant({
    tenantId: hotel.tenantId,
    propertyId: hotel.propertyId,
    stayId: hotel.stayId,
    guestId: hotel.guestId,
    via: 'STAFF',
    actor: { type: 'SYSTEM', id: null },
    reason: 'test',
  });
  return (await guests.openGuestSession(hotel.tenantId, grant.id, 'test')).token;
}
