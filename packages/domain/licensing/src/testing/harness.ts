import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
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
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { LicenseCatalogService } from '../application/catalog.service';
import { LicensingModule } from '../licensing.module';

/** Test-only composition of the licensing context with the platform it needs; tenants are inserted as rows. */

export const ADMIN = JSON.stringify({
  type: 'USER',
  id: 'admin',
  tenantId: null,
  isPlatformAdmin: true,
});
export const staff = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });

export interface LicensingHarness {
  readonly app: INestApplication;
  readonly db: Database;
  readonly http: () => ReturnType<typeof request>;
}

export async function startLicensingApp(
  url: string,
  role: string,
  grants: Record<string, readonly string[]> = {},
): Promise<LicensingHarness> {
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
      HttpConventionsModule.forRoot({ store: 'memory' }),
      DatabaseModule.forRoot(),
      EventsModule.forRoot(),
      FeatureFlagsModule,
      ManifestModule.forRoot(),
      AuditModule,
      AuthModule.forRoot({
        strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
        resolver: { provide: PERMISSION_RESOLVER, useValue: new StaticPermissionResolver(grants) },
      }),
      LicensingModule,
    ],
  }).compile();
  const app = ref.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
  // The boot sync runs in the background; tests wait for it.
  await app.get(LicenseCatalogService).sync();
  return { app, db: app.get(DATABASE), http: () => request(app.getHttpServer()) };
}

/** A tenant row with one property, as the organization context would have written them. */
export async function createTenant(
  h: LicensingHarness,
  code: string,
): Promise<{ tenantId: string; propertyId: string }> {
  const tenantId = newId();
  const propertyId = newId();
  await h.db.execute(
    sql`insert into org.tenants (id, code, name) values (${tenantId}, ${code}, ${code})`,
  );
  await h.db.execute(
    sql`insert into org.properties (id, tenant_id, code, name, timezone, currency) values (${propertyId}, ${tenantId}, ${'P1'}, ${'Nile View'}, ${'Africa/Cairo'}, ${'EGP'})`,
  );
  return { tenantId, propertyId };
}
