import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GuestModule } from '@hotella/domain-guest';
import { IDENTITY_API } from '@hotella/domain-identity/public';
import { IntegrationsModule } from '@hotella/domain-integrations';
import { ENGINEERING_API } from '@hotella/domain-engineering/public';
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
import { StorageService } from '@hotella/platform-storage';
import { InspectionModule } from '../inspection.module';

/** Test-only composition of inspections with organization and the operations engine (worker consumers registered, not run). */

/** Staff a test makes assignable (operations asks identity who holds `task.accept` at the property). */
export const ASSIGNABLE = new Set<string>();

/** Operations looks staff up through identity; nobody is notified in these tests. */
@Global()
@Module({
  providers: [
    {
      provide: IDENTITY_API,
      useValue: {
        getStaffMember: async () => null,
        usersWithPermission: async () => [...ASSIGNABLE],
        usersWithRole: async () => [],
        getStaffContact: async () => null,
      },
    },
  ],
  exports: [IDENTITY_API],
})
class FakeIdentityModule {}

export const ADMIN = JSON.stringify({
  type: 'USER',
  id: 'admin',
  tenantId: null,
  isPlatformAdmin: true,
});
export const staff = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

/** Equipment as inspections see it (engineering is a separate context): one known asset per test. */
export const ASSETS = new Map<string, { propertyId: string; locationId: string }>();
@Global()
@Module({
  providers: [
    {
      provide: ENGINEERING_API,
      useValue: {
        getAsset: async (_tenantId: string, propertyId: string, id: string) => {
          const a = ASSETS.get(id);
          return a && a.propertyId === propertyId
            ? {
                id,
                propertyId,
                assetNumber: 'FCU-1',
                name: 'Unit',
                assetTypeId: id,
                assetModelId: null,
                locationId: a.locationId,
                status: 'ACTIVE',
                criticality: 'MEDIUM',
                warrantyUntil: null,
              }
            : null;
        },
        assetsAtLocation: async () => [],
        activeRestriction: async () => null,
      },
    },
  ],
  exports: [ENGINEERING_API],
})
class FakeEngineeringModule {}

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

export interface InspectionHarness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly http: () => ReturnType<typeof request>;
}

export async function startInspectionApp(
  url: string,
  role: string,
  grants: Record<string, readonly string[]>,
): Promise<InspectionHarness> {
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
      FakeIdentityModule,
      OperationsModule,
      FakeEngineeringModule,
      FakeStorageModule,
      InspectionModule,
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
  readonly rooms: Record<string, string>;
  /** The property's root location (e.g. for plant rooms). */
  readonly rootId: string;
}

export async function createHotel(
  h: InspectionHarness,
  code: string,
  gmId: string,
  roomNumbers: readonly string[] = ['504', '505'],
): Promise<Hotel> {
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
      .send({ code: 'ENG', name: 'Nile View', timezone: 'Africa/Cairo', currency: 'EGP' })
      .expect(201)
  ).body.id as string;
  const tree = await h
    .http()
    .get(`/properties/${propertyId}/locations`)
    .set('X-Test-Actor', gm)
    .expect(200);
  const rootId = (Array.isArray(tree.body) ? tree.body[0].id : tree.body.id) as string;
  const rooms: Record<string, string> = {};
  for (const n of roomNumbers)
    rooms[n] = (
      await h
        .http()
        .post(`/properties/${propertyId}/rooms`)
        .set('X-Test-Actor', gm)
        .send({ parentId: rootId, roomNumber: n })
        .expect(201)
    ).body.locationId as string;
  return { tenantId, propertyId, rooms, rootId };
}
