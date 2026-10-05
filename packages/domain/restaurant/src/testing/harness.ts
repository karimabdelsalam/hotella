import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { GuestModule } from '@hotella/domain-guest';
import { IDENTITY_API } from '@hotella/domain-identity/public';
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
} from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { EnvSecretProvider, SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { RestaurantModule } from '../restaurant.module';

/** Test-only composition of the restaurant context with what it builds on. */

export const PLATFORM_ADMIN = JSON.stringify({
  type: 'USER',
  id: 'admin',
  tenantId: null,
  isPlatformAdmin: true,
});
export const staff = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

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

export interface Harness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly http: () => ReturnType<typeof request>;
}

export async function startRestaurantApp(
  url: string,
  role: string,
  grants: Record<string, readonly string[]>,
): Promise<Harness> {
  await runMigrations(url);
  const env = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: await applicationRoleUrl(url, role),
    VALKEY_URL: 'redis://127.0.0.1:1',
    PUBLIC_BASE_URL: 'https://guest.example.test',
  };
  const ref = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ env }),
      ObservabilityModule.forRoot(),
      I18nModule.forRoot(),
      SecretsModule.forRoot({ providers: [new EnvSecretProvider({ FAKE_SECRET: 'fake' })] }),
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
      }),
      OrganizationModule,
      IntegrationsModule,
      GuestModule,
      FakeIdentityModule,
      RestaurantModule,
    ],
  }).compile();
  const app = ref.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  return { app, db: app.get(DATABASE), http: () => request(app.getHttpServer()) };
}

export interface Hotel {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly rooms: Record<string, string>;
}

/** A tenant with one property (Cairo) and rooms, created through the public APIs. */
export async function createHotel(
  h: Harness,
  code: string,
  actorId: string,
  roomNumbers: readonly string[],
): Promise<Hotel> {
  const tenantId = (
    await h
      .http()
      .post('/tenants')
      .set('X-Test-Actor', PLATFORM_ADMIN)
      .send({ code, name: code })
      .expect(201)
  ).body.id as string;
  const actor = staff(actorId, tenantId);
  const propertyId = (
    await h
      .http()
      .post('/properties')
      .set('X-Test-Actor', actor)
      .send({
        code: 'RST',
        name: 'Red Sea Resort',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        country: 'EG',
      })
      .expect(201)
  ).body.id as string;
  const base = `/properties/${propertyId}`;
  const tree = await h.http().get(`${base}/locations`).set('X-Test-Actor', actor).expect(200);
  const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
  const rooms: Record<string, string> = {};
  for (const n of roomNumbers)
    rooms[n] = (
      await h
        .http()
        .post(`${base}/rooms`)
        .set('X-Test-Actor', actor)
        .send({ parentId: root, roomNumber: n })
        .expect(201)
    ).body.locationId;
  return { tenantId, propertyId, rooms };
}

/** An in-house stay as the guest context projects it from the PMS, for `nights` nights from `arrival`. */
export async function seedStay(
  db: Database,
  hotel: Hotel,
  room: string,
  arrival: string,
  nights: number,
): Promise<{ stayId: string; primary: string }> {
  const primary = newId();
  const stayId = newId();
  const { tenantId, propertyId } = hotel;
  const d = new Date(`${arrival}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + nights);
  const departure = d.toISOString().slice(0, 10);
  await db.execute(sql`insert into guest.guests (id, tenant_id, given_name, family_name, primary_locale)
    values (${primary}, ${tenantId}, 'Giulia', 'Rossi', 'it')`);
  await db.execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, actual_checkin_at, last_pms_event_at)
    values (${stayId}, ${tenantId}, ${propertyId}, 'IN_HOUSE', ${primary}, ${arrival}, ${departure}, now(), now())`);
  await db.execute(sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at)
    values (${newId()}, ${tenantId}, ${stayId}, ${primary}, 'PRIMARY', now())`);
  await db.execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
    values (${newId()}, ${tenantId}, ${propertyId}, ${stayId}, ${hotel.rooms[room]!}, now(), 'INITIAL')`);
  return { stayId, primary };
}

/** A guest session as activation would produce it. */
export async function guestSession(
  h: Harness,
  hotel: Hotel,
  stayId: string,
  guestId: string,
): Promise<string> {
  const guests = h.app.get<GuestPublicApi>(GUEST_API);
  const grant = await guests.issueGrant({
    tenantId: hotel.tenantId,
    propertyId: hotel.propertyId,
    stayId,
    guestId,
    via: 'STAFF',
    actor: { type: 'SYSTEM', id: null },
    reason: 'test',
  });
  return (await guests.openGuestSession(hotel.tenantId, grant.id, 'test')).token;
}
