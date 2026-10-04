import 'reflect-metadata';
import {
  Controller,
  Get,
  type INestApplication,
  Module,
  type OnModuleInit,
  Query,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { AuditModule } from '@hotella/platform-audit';
import {
  ActionGate,
  ActorStore,
  AUTHENTICATION_STRATEGY,
  AuthModule,
  HeaderActorStrategy,
  PERMISSION_RESOLVER,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
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
import { defineManifest, ManifestModule, ManifestRegistry } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SettingsModule } from '@hotella/platform-settings';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { LicenseCatalogService } from '../application/catalog.service';
import { LicensingCoreModule, LicensingModule } from '../licensing.module';
import { WhiteLabelSweep } from '../application/white-label.sweep';

/** Test-only composition of the licensing context with the platform it needs; tenants are inserted as rows. */

/** A stand-in module whose permission needs HOUSEKEEPING, and a CORE action (a permission no module declares). */
const DEMO_MANIFEST = defineManifest({
  code: 'demo',
  schema: 'platform',
  description: 'Test-only module gated by an entitlement.',
  permissions: [{ code: 'demo.board.read', descriptionKey: 'demo.read', risk: 'READ' }],
  entitlements: ['HOUSEKEEPING'],
  entitlement: 'HOUSEKEEPING',
});

@Controller('demo')
class DemoController {
  constructor(
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
  ) {}
  @Get('board')
  board(@Query('propertyId') propertyId?: string) {
    const tenantId = this.actors.require().tenantId;
    return this.gate.execute(
      { action: 'demo.board.read', tenantId, propertyId: propertyId ?? null },
      async () => ({ ok: true }),
    );
  }
  @Get('core')
  core(@Query('propertyId') propertyId?: string) {
    const tenantId = this.actors.require().tenantId;
    return this.gate.execute(
      { action: 'org.property.read', tenantId, propertyId: propertyId ?? null },
      async () => ({ ok: true }),
    );
  }
}

/** The worker's white-label sweep, so tests can run it in this API-shaped app. */
@Module({ controllers: [DemoController], providers: [WhiteLabelSweep] })
class DemoModule implements OnModuleInit {
  constructor(private readonly manifests: ManifestRegistry) {}
  onModuleInit(): void {
    this.manifests.register(DEMO_MANIFEST);
  }
}

/** Property ownership straight from the rows (the organization context is not composed here). */
function rowVerifier(db: () => Database): PropertyScopeVerifier {
  const owner = async (propertyId: string) =>
    (
      (await db().execute(sql`select tenant_id from org.properties where id = ${propertyId}`))
        .rows[0] as { tenant_id: string } | undefined
    )?.tenant_id ?? null;
  return {
    propertyBelongsToTenant: async (propertyId, tenantId) => (await owner(propertyId)) === tenantId,
    tenantOfProperty: owner,
  };
}

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
      SettingsModule,
      AuthModule.forRoot({
        strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
        resolver: { provide: PERMISSION_RESOLVER, useValue: new StaticPermissionResolver(grants) },
        propertyVerifier: {
          provide: PROPERTY_SCOPE_VERIFIER,
          inject: [DATABASE],
          useFactory: (db: Database) => rowVerifier(() => db),
        },
        stages: [LicensingCoreModule.entitlementStage()],
      }),
      LicensingModule,
      DemoModule,
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
