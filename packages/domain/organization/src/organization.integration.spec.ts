import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditModule } from '@hotella/platform-audit';
import {
  AUTHENTICATION_STRATEGY,
  AuthModule,
  HeaderActorStrategy,
  PERMISSION_RESOLVER,
  StaticPermissionResolver,
} from '@hotella/platform-auth';
import { ConfigModule } from '@hotella/platform-config';
import { DatabaseModule, runMigrations } from '@hotella/platform-database';
import { EventsModule } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrganizationModule } from './organization.module';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(
  `Organization & Property against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let app: INestApplication;
    let tenantA: string;
    let tenantB: string;
    let propertyA: string;
    let propertyB: string;
    const grants: Record<string, string[]> = {};

    beforeAll(async () => {
      await runMigrations(url);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: url,
        VALKEY_URL: 'redis://127.0.0.1:1',
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
            resolver: {
              provide: PERMISSION_RESOLVER,
              useValue: new StaticPermissionResolver(grants),
            },
            propertyVerifier: OrganizationModule.propertyVerifier(),
          }),
          OrganizationModule,
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
    });
    afterAll(() => app?.close());

    it('platform admin creates two tenants; codes are normalized and unique', async () => {
      const a = await request(app.getHttpServer())
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `nile ${stamp}`, name: 'Nile Group' })
        .expect(201);
      tenantA = a.body.id;
      expect(a.body.code).toBe(`NILE_${stamp}`);
      const b = await request(app.getHttpServer())
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `red-${stamp}`, name: 'Red Sea Hotels', defaultLocale: 'ar' })
        .expect(201);
      tenantB = b.body.id;
      const dup = await request(app.getHttpServer())
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `nile ${stamp}`, name: 'x' })
        .expect(409);
      expect(dup.body.code).toBe('org.tenant.code_taken');
      await request(app.getHttpServer())
        .post('/tenants')
        .set('X-Test-Actor', user('ua', tenantA))
        .send({ code: 'X1', name: 'x' })
        .expect(403);
      grants['ua'] = [
        'org.property.read',
        'org.property.manage',
        'org.location.manage',
        'branding.read',
        'branding.manage',
      ];
      grants['ub'] = [
        'org.property.read',
        'org.property.manage',
        'org.location.manage',
        'branding.read',
        'branding.manage',
      ];
      grants['hk'] = [];
    });

    it('tenant users create properties in their own tenant; the root location is created with it', async () => {
      const a = await request(app.getHttpServer())
        .post('/properties')
        .set('X-Test-Actor', user('ua', tenantA))
        .send({
          code: 'NILE-CAI',
          name: 'Nile Palace Cairo',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
          enabledLocales: ['en', 'ar'],
        })
        .expect(201);
      propertyA = a.body.id;
      expect(a.body.tenantId).toBe(tenantA);
      const b = await request(app.getHttpServer())
        .post('/properties')
        .set('X-Test-Actor', user('ub', tenantB))
        .send({
          code: 'RED-HRG',
          name: 'Red Sea Hurghada',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
          defaultLocale: 'ar',
        })
        .expect(201);
      propertyB = b.body.id;
      const tree = await request(app.getHttpServer())
        .get(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', user('ua', tenantA))
        .expect(200);
      expect(tree.body).toHaveLength(1);
      expect(tree.body[0]).toMatchObject({
        kind: 'PROPERTY',
        code: 'NILE-CAI',
        path: 'NILE_CAI',
        name: 'Nile Palace Cairo',
      });
      // a tenant user naming another tenant explicitly is told it does not exist
      await request(app.getHttpServer())
        .post('/properties')
        .set('X-Test-Actor', user('ua', tenantA))
        .send({
          tenantId: tenantB,
          code: 'XX',
          name: 'x',
          timezone: 'Africa/Cairo',
          currency: 'EGP',
        })
        .expect(404);
    });

    it('cross-tenant access is a 404, never a 403 that confirms existence; missing permission is 403', async () => {
      const res = await request(app.getHttpServer())
        .get(`/properties/${propertyB}`)
        .set('X-Test-Actor', user('ua', tenantA))
        .expect(404);
      expect(res.body.code).toBe('org.property.not_found');
      await request(app.getHttpServer())
        .get(`/properties/${propertyA}`)
        .set('X-Test-Actor', user('hk', tenantA))
        .expect(403);
      const list = await request(app.getHttpServer())
        .get('/properties')
        .set('X-Test-Actor', user('ua', tenantA))
        .expect(200);
      expect(list.body.map((p: { id: string }) => p.id)).toEqual([propertyA]);
      // platform admin sees any tenant when naming it
      const adminList = await request(app.getHttpServer())
        .get(`/properties?tenantId=${tenantB}`)
        .set('X-Test-Actor', admin)
        .expect(200);
      expect(adminList.body.map((p: { id: string }) => p.id)).toEqual([propertyB]);
    });

    it('builds a localized location tree with rooms as leaves', async () => {
      const ua = user('ua', tenantA);
      const building = await request(app.getHttpServer())
        .post(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', ua)
        .send({
          kind: 'BUILDING',
          code: 'MAIN',
          translations: [
            { locale: 'en', name: 'Main Building' },
            { locale: 'ar', name: 'المبنى الرئيسي' },
          ],
        })
        .expect(201);
      const floor = await request(app.getHttpServer())
        .post(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', ua)
        .send({
          parentId: building.body.id,
          kind: 'FLOOR',
          code: 'F5',
          translations: [{ locale: 'en', name: 'Floor 5' }],
        })
        .expect(201);
      expect(floor.body.path).toBe('NILE_CAI.MAIN.F5');
      const type = await request(app.getHttpServer())
        .post(`/properties/${propertyA}/room-types`)
        .set('X-Test-Actor', ua)
        .send({
          code: 'DLX',
          capacity: 2,
          translations: [
            { locale: 'en', name: 'Deluxe' },
            { locale: 'ar', name: 'ديلوكس' },
          ],
        })
        .expect(201);
      const room = await request(app.getHttpServer())
        .post(`/properties/${propertyA}/rooms`)
        .set('X-Test-Actor', ua)
        .send({
          parentId: floor.body.id,
          roomNumber: '504',
          roomTypeId: type.body.id,
          bedConfig: 'KING',
        })
        .expect(201);
      expect(room.body.locationId).toBeDefined();
      await request(app.getHttpServer())
        .post(`/properties/${propertyA}/rooms`)
        .set('X-Test-Actor', ua)
        .send({ parentId: floor.body.id, roomNumber: '504' })
        .expect(409);
      // a room cannot be a parent
      await request(app.getHttpServer())
        .post(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', ua)
        .send({
          parentId: room.body.locationId,
          kind: 'AREA',
          code: 'BALCONY',
          translations: [{ locale: 'en', name: 'x' }],
        })
        .expect(422);

      const ar = await request(app.getHttpServer())
        .get(`/properties/${propertyA}/locations?lang=ar`)
        .set('X-Test-Actor', ua)
        .expect(200);
      const mainAr = ar.body[0].children[0];
      expect(mainAr.name).toBe('المبنى الرئيسي');
      expect(mainAr.children[0].name).toBe('Floor 5'); // no Arabic translation → property default (en)
      const roomNode = mainAr.children[0].children[0];
      expect(roomNode).toMatchObject({
        kind: 'ROOM',
        code: '504',
        name: '504',
        room: { roomNumber: '504', roomTypeName: 'ديلوكس', bedConfig: 'KING' },
      });
      // the other tenant cannot see or write into this tree
      await request(app.getHttpServer())
        .get(`/properties/${propertyA}/locations`)
        .set('X-Test-Actor', user('ub', tenantB))
        .expect(404);
    });

    it('branding resolves per property with inheritance and the attribution can never be removed', async () => {
      const ua = user('ua', tenantA);
      await request(app.getHttpServer())
        .put('/branding/profiles')
        .set('X-Test-Actor', ua)
        .send({
          scope: 'TENANT',
          scopeId: tenantA,
          primaryColor: '#0B3D91',
          displayName: 'Nile Group',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/branding/profiles')
        .set('X-Test-Actor', ua)
        .send({
          scope: 'PROPERTY',
          scopeId: propertyA,
          displayName: 'Nile Palace',
          typography: { arabic: 'Cairo' },
          translations: [
            { locale: 'ar', welcomeText: 'أهلاً بك في قصر النيل' },
            { locale: 'en', welcomeText: 'Welcome to Nile Palace' },
          ],
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/branding/profiles')
        .set('X-Test-Actor', ua)
        .send({
          scope: 'CHANNEL',
          scopeId: propertyA,
          channel: 'WHATSAPP',
          aiPersona: { tone: 'concise' },
        })
        .expect(200);
      // tenant A cannot brand tenant B's property
      await request(app.getHttpServer())
        .put('/branding/profiles')
        .set('X-Test-Actor', ua)
        .send({ scope: 'PROPERTY', scopeId: propertyB, displayName: 'hijack' })
        .expect(404);

      const web = await request(app.getHttpServer())
        .get(`/public/branding?property=${propertyA}&channel=GUEST_WEB&lang=ar`)
        .expect(200);
      expect(web.body).toMatchObject({
        displayName: 'Nile Palace',
        primaryColor: '#0B3D91',
        direction: 'rtl',
        welcomeText: 'أهلاً بك في قصر النيل',
        attribution: { show: true, label: 'Powered by Planova', href: 'https://planova.com.eg' },
      });
      expect(web.body.typography.arabic).toBe('Cairo');
      expect(web.body.layers).toEqual(['platform', 'tenant', 'property']);
      const wa = await request(app.getHttpServer())
        .get(`/public/branding?property=${propertyA}&channel=WHATSAPP`)
        .expect(200);
      expect(wa.body.aiPersona.tone).toBe('concise');
      expect(wa.body.layers).toContain('channel');
      // property B: no profiles → property name + platform defaults, Arabic default locale, attribution intact
      const b = await request(app.getHttpServer())
        .get(`/public/branding?property=${propertyB}`)
        .expect(200);
      expect(b.body).toMatchObject({
        displayName: 'Red Sea Hurghada',
        locale: 'ar',
        direction: 'rtl',
        layers: ['platform'],
        attribution: { href: 'https://planova.com.eg' },
      });
      expect(b.body.primaryColor).not.toBe('#0B3D91');
    });
  },
);
