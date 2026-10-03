import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
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
import { MODEL_GATEWAY } from '@hotella/domain-ai/public';
import { StorageService } from '@hotella/platform-storage';
import { AttributesService } from '../application/attributes.service';
import { LostFoundModule } from '../lostfound.module';

/** Test-only composition of Lost & Found with organization, guests, fake storage and a fake Model Gateway. */

export const ADMIN = JSON.stringify({
  type: 'USER',
  id: 'admin',
  tenantId: null,
  isPlatformAdmin: true,
});
export const staff = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

/** In-memory object storage standing in for SeaweedFS. */
export const OBJECTS = new Map<string, Buffer>();
@Global()
@Module({
  providers: [
    {
      provide: StorageService,
      useValue: {
        put: async (o: { key: string; body: Buffer }) => {
          OBJECTS.set(o.key, Buffer.from(o.body));
          return { key: o.key, bucket: 'test' };
        },
        getBuffer: async (key: string) => {
          const b = OBJECTS.get(key);
          if (!b) throw new Error('NoSuchKey');
          return b;
        },
      },
    },
  ],
  exports: [StorageService],
})
class FakeStorageModule {}

/** The Model Gateway as Lost & Found sees it: the test sets the next answer (or an error). */
export const GATEWAY = {
  answer: null as string | null,
  fail: false,
  calls: [] as Array<{ capability: string; messages: unknown[] }>,
};
@Global()
@Module({
  providers: [
    {
      provide: MODEL_GATEWAY,
      useValue: {
        complete: async (input: { capability: string; messages: unknown[] }) => {
          GATEWAY.calls.push({ capability: input.capability, messages: input.messages });
          if (GATEWAY.fail) throw new Error('provider down');
          return {
            content: GATEWAY.answer,
            toolCalls: [],
            finishReason: 'stop',
            provider: 'fake',
            model: 'fake',
            modelCallId: 'call-1',
            costMinor: 0,
            fallbackFrom: null,
          };
        },
      },
    },
    AttributesService,
  ],
  exports: [MODEL_GATEWAY, AttributesService],
})
class FakeGatewayModule {}

export interface LostFoundHarness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly http: () => ReturnType<typeof request>;
}

export async function startLostFoundApp(
  url: string,
  role: string,
  grants: Record<string, readonly string[]>,
): Promise<LostFoundHarness> {
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
      SecretsModule.forRoot({
        providers: [new EnvSecretProvider({ COMMS_OTP_HMAC_KEY: 'test-otp-key' })],
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
        stages: [IntegrationsModule.capabilityStage()],
      }),
      OrganizationModule,
      IntegrationsModule,
      GuestModule,
      FakeStorageModule,
      LostFoundModule,
      FakeGatewayModule,
    ],
  }).compile();
  const app = ref.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  return { app, db: app.get(DATABASE), http: () => request(app.getHttpServer()) };
}

export interface Hotel {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly roomId: string;
  readonly stayId: string;
  readonly guestId: string;
}

/** A tenant with one property, a room and an in-house stay (rows written the way the PMS projection writes them). */
export async function createHotel(h: LostFoundHarness, code: string, gmId: string): Promise<Hotel> {
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
      .send({ code: 'LFD', name: 'Nile View', timezone: 'Africa/Cairo', currency: 'EGP' })
      .expect(201)
  ).body.id as string;
  const tree = await h
    .http()
    .get(`/properties/${propertyId}/locations`)
    .set('X-Test-Actor', gm)
    .expect(200);
  const rootId = (Array.isArray(tree.body) ? tree.body[0].id : tree.body.id) as string;
  const roomId = (
    await h
      .http()
      .post(`/properties/${propertyId}/rooms`)
      .set('X-Test-Actor', gm)
      .send({ parentId: rootId, roomNumber: '504' })
      .expect(201)
  ).body.locationId as string;
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
  return { tenantId, propertyId, roomId, stayId, guestId };
}
