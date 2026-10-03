import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { KNOWLEDGE_API } from '@hotella/domain-knowledge/public';
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
import { SecretsModule } from '@hotella/platform-secrets';
import { SettingsModule } from '@hotella/platform-settings';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { EngineeringModule } from '../engineering.module';

/** Test-only composition of engineering with organization (no worker, no AI). */

export const ADMIN = JSON.stringify({
  type: 'USER',
  id: 'admin',
  tenantId: null,
  isPlatformAdmin: true,
});
export const staff = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

/** Knowledge as engineering sees it: a document's identity, read straight from its table. */
@Global()
@Module({
  providers: [
    {
      provide: KNOWLEDGE_API,
      inject: [DATABASE],
      useFactory: (db: Database) => ({
        search: async () => [],
        getDocument: async (tenantId: string, id: string) => {
          const { rows } = await db.execute(
            sql`select id, property_id, kind, title, status from knowledge.documents where id = ${id} and tenant_id = ${tenantId}`,
          );
          const d = rows[0] as
            | {
                id: string;
                property_id: string | null;
                kind: string;
                title: string;
                status: string;
              }
            | undefined;
          return d
            ? {
                id: d.id,
                propertyId: d.property_id,
                kind: d.kind,
                title: d.title,
                status: d.status,
              }
            : null;
        },
      }),
    },
  ],
  exports: [KNOWLEDGE_API],
})
class FakeKnowledgeModule {}

export interface EngHarness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly http: () => ReturnType<typeof request>;
}

export async function startEngineeringApp(
  url: string,
  role: string,
  grants: Record<string, readonly string[]>,
): Promise<EngHarness> {
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
      SecretsModule.forRoot(),
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
      FakeKnowledgeModule,
      EngineeringModule,
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
  /** The property's root location (e.g. for plant rooms). */
  readonly rootId: string;
}

export async function createHotel(
  h: EngHarness,
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
