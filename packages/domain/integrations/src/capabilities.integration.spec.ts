import 'reflect-metadata';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { ENTITLEMENT_API } from '@hotella/domain-licensing/public';
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
  withTransaction,
} from '@hotella/platform-database';
import { EventsModule, eventsSchema } from '@hotella/platform-events';
import { FeatureFlagsModule } from '@hotella/platform-flags';
import { HttpConventionsModule } from '@hotella/platform-http';
import { I18nModule } from '@hotella/platform-i18n';
import { ManifestModule } from '@hotella/platform-manifest';
import { ObservabilityModule } from '@hotella/platform-observability';
import { SettingsModule } from '@hotella/platform-settings';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationCommands, integrationHealth } from './infrastructure/schema';
import { IntegrationsModule } from './integrations.module';
import { INTEGRATIONS_API, type IntegrationsPublicApi, PMS_API, type PmsPublicApi } from './public';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const ALL = [
  'org.property.read',
  'org.property.manage',
  'integration.read',
  'integration.configure',
  'integration.capability.manage',
  'integration.capability.verify',
];
/** Connector entitlements the test tenant holds (the real engine is tested in the licensing context). */
const licensed = new Set(['CONNECTOR_OPERA5', 'CONNECTOR_PMS']);

@Global()
@Module({
  providers: [
    {
      provide: ENTITLEMENT_API,
      useValue: {
        can: async (_t: string, _p: string | null, c: string) => licensed.has(c),
        entitledUntil: async () => null,
        effective: async () => [],
        assertWithinLimit: async () => undefined,
      },
    },
  ],
  exports: [ENTITLEMENT_API],
})
class FakeLicensingModule {}

describe.skipIf(needsInfra())(
  `PMS capability registry and PMS_API against PostgreSQL (${infraSkipReason()})`,
  () => {
    const url = readTestInfra().databaseUrl!;
    let app: INestApplication;
    let db: Database;
    let pms: PmsPublicApi;
    let tenant: string;
    let other: string;
    const hotels: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
    const instances: Record<string, string> = {};
    const http = () => request(app.getHttpServer());
    const gm = () => user('gm', tenant);
    const cap = (property: string) => `/properties/${property}/integration`;

    const instance = async (
      property: string,
      connectorCode: string,
      capabilities: string[],
    ): Promise<string> => {
      const created = await http()
        .post(`/properties/${property}/integrations`)
        .set('X-Test-Actor', gm())
        .send({ connectorCode, name: connectorCode, capabilities })
        .expect(201);
      await http()
        .patch(`/properties/${property}/integrations/${created.body.id}`)
        .set('X-Test-Actor', gm())
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      return created.body.id as string;
    };
    const verify = (property: string, capability: string, instanceId: string) =>
      http()
        .post(`${cap(property)}/capabilities/${capability}/verify`)
        .set('X-Test-Actor', gm())
        .send({ instanceId, evidenceRef: `commissioning ${capability}` })
        .expect(200);
    const view = async (property: string) =>
      (
        await http()
          .get(`${cap(property)}/capabilities`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as {
        capabilities: Array<{
          capability: string;
          effective: boolean;
          connectors: Array<{ connectorCode: string; effective: boolean; reasons: string[] }>;
        }>;
        routing: Array<{ operation: string; route: Array<{ connectorCode: string }> }>;
      };
    const of = (v: Awaited<ReturnType<typeof view>>, capability: string) =>
      v.capabilities.find((c) => c.capability === capability);
    const routeOf = (v: Awaited<ReturnType<typeof view>>, operation: string) =>
      v.routing.find((r) => r.operation === operation)!.route.map((r) => r.connectorCode);
    const roomStatus = (property: string, key: string) =>
      pms.setRoomStatus({
        tenantId: tenant,
        propertyId: property,
        roomNumber: '504',
        status: 'CLEAN',
        occupied: false,
        idempotencyKey: key,
        requestedBy: { type: 'SYSTEM', id: null },
      });
    const changes = (property: string) =>
      db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.eventType, 'integration.capability.changed'),
            eq(eventsSchema.outbox.propertyId, property),
          ),
        );

    beforeAll(async () => {
      await runMigrations(url);
      const env = {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_capabilities'),
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
          SettingsModule,
          AuthModule.forRoot({
            strategy: { provide: AUTHENTICATION_STRATEGY, useClass: HeaderActorStrategy },
            resolver: {
              provide: PERMISSION_RESOLVER,
              useValue: new StaticPermissionResolver({ gm: ALL, other: ALL }),
            },
            propertyVerifier: OrganizationModule.propertyVerifier(),
            stages: [IntegrationsModule.capabilityStage()],
          }),
          OrganizationModule,
          FakeLicensingModule,
          IntegrationsModule,
        ],
      }).compile();
      app = ref.createNestApplication({ logger: false });
      app.useGlobalPipes(new ZodValidationPipe());
      await app.init();
      db = app.get(DATABASE);
      pms = app.get(PMS_API);
      const tenantOf = async (code: string) =>
        (
          await http()
            .post('/tenants')
            .set('X-Test-Actor', admin)
            .send({ code: `${code}-${stamp}`, name: code })
            .expect(201)
        ).body.id as string;
      tenant = await tenantOf('cap-a');
      other = await tenantOf('cap-b');
      for (const h of ['A', 'B', 'C'] as const)
        hotels[h] = (
          await http()
            .post('/properties')
            .set('X-Test-Actor', gm())
            .send({ code: `H${h}`, name: `Hotel ${h}`, timezone: 'Africa/Cairo', currency: 'EGP' })
            .expect(201)
        ).body.id;
      const fias = ['CHECKIN_EVENT', 'CHECKOUT_EVENT', 'ROOM_STATUS_WRITE', 'RECONCILIATION_READ'];
      // A: IFC8 only (the database connector arrives with link protocol 2, BUILD_PLAN 10.7).
      instances.aFias = await instance(hotels.A, 'OPERA5_FIAS', fias);
      // B: IFC8 + OWS.
      instances.bFias = await instance(hotels.B, 'OPERA5_FIAS', fias);
      instances.bOws = await instance(hotels.B, 'OPERA5_OWS', ['RESERVATION_READ', 'GUEST_READ']);
      // C: the simulator standing in for every face.
      instances.cSim = await instance(hotels.C, 'SIM_PMS', [
        'CHECKIN_EVENT',
        'ROOM_STATUS_WRITE',
        'OOO_WRITE',
        'RECONCILIATION_READ',
      ]);
    });
    afterAll(() => app?.close());

    it('offers no PMS write before it is verified, and explains why', async () => {
      const a = await view(hotels.A);
      expect(of(a, 'ROOM_STATUS_WRITE')).toMatchObject({
        effective: false,
        connectors: [{ connectorCode: 'OPERA5_FIAS', effective: false, reasons: ['NOT_VERIFIED'] }],
      });
      // Reads and events run unverified while the instance is in commissioning.
      expect(of(a, 'CHECKIN_EVENT')).toMatchObject({ effective: true });
      expect(of(a, 'ROOM_MOVE_EVENT')!.connectors[0]!.reasons).toEqual(['NOT_ENABLED']);
      expect(await pms.can(tenant, hotels.A, 'ROOM_STATUS_WRITE')).toBe(false);
      expect(await roomStatus(hotels.A, `a-${stamp}-1`)).toEqual({
        outcome: 'UNAVAILABLE',
        capability: 'ROOM_STATUS_WRITE',
      });
    });

    it('hotels A, B and C run the same room-status write through their own connector (guide §5.4)', async () => {
      await verify(hotels.A, 'ROOM_STATUS_WRITE', instances.aFias!);
      await verify(hotels.B, 'ROOM_STATUS_WRITE', instances.bFias!);
      await verify(hotels.C, 'ROOM_STATUS_WRITE', instances.cSim!);
      const outcomes = await Promise.all(
        (['A', 'B', 'C'] as const).map((h) => roomStatus(hotels[h], `${h}-${stamp}-2`)),
      );
      expect(outcomes.map((o) => (o.outcome === 'QUEUED' ? o.connectorCode : o.outcome))).toEqual([
        'OPERA5_FIAS',
        'OPERA5_FIAS',
        'SIM_PMS',
      ]);
      const [command] = await db
        .select()
        .from(integrationCommands)
        .where(eq(integrationCommands.instanceId, instances.bFias!));
      expect(command!.commandType).toBe('SET_ROOM_STATUS');
      expect(command!.routing).toMatchObject({
        operation: 'SET_ROOM_STATUS',
        chosen: 'OPERA5_FIAS',
        route: ['OPERA5_FIAS'],
      });
      // One command only, on the chosen connector, and a repeat is the same command.
      const again = await roomStatus(hotels.B, `B-${stamp}-2`);
      expect(again).toMatchObject({
        outcome: 'QUEUED',
        commandId: (outcomes[1] as { commandId: string }).commandId,
      });
      const b = await view(hotels.B);
      expect(routeOf(b, 'SET_ROOM_STATUS')).toEqual(['OPERA5_FIAS']);
      expect(routeOf(b, 'UPDATE_PROFILE_CONTACT')).toEqual([]);
      expect(routeOf(await view(hotels.C), 'SET_ROOM_RESTRICTION')).toEqual([]);
    });

    it('announces each change of a property capability once', async () => {
      const events = await changes(hotels.A);
      const payloads = events.map(
        (e) => (e.envelope as { payload: { capability: string } }).payload,
      );
      expect(payloads.filter((p) => p.capability === 'ROOM_STATUS_WRITE')).toEqual([
        { capability: 'ROOM_STATUS_WRITE', effective: true, connectors: ['OPERA5_FIAS'] },
      ]);
    });

    it('a licence that ends, or a link that cannot authenticate, stops the capability', async () => {
      licensed.delete('CONNECTOR_OPERA5');
      expect(await pms.can(tenant, hotels.A, 'ROOM_STATUS_WRITE')).toBe(false);
      expect(of(await view(hotels.A), 'ROOM_STATUS_WRITE')!.connectors[0]!.reasons).toEqual([
        'NOT_LICENSED',
      ]);
      licensed.add('CONNECTOR_OPERA5');
      await withTransaction(db, () =>
        db
          .update(integrationHealth)
          .set({ status: 'AUTH_FAILED' })
          .where(eq(integrationHealth.instanceId, instances.aFias!)),
      );
      expect(await pms.can(tenant, hotels.A, 'ROOM_STATUS_WRITE')).toBe(false);
      await withTransaction(db, () =>
        db
          .update(integrationHealth)
          .set({ status: 'OFFLINE' })
          .where(eq(integrationHealth.instanceId, instances.aFias!)),
      );
      // Offline agents still take commands: they are durable and wait for the link.
      expect(await pms.can(tenant, hotels.A, 'ROOM_STATUS_WRITE')).toBe(true);
    });

    it('after the sign-off every capability must be verified, reads and events included', async () => {
      await http()
        .post(`${cap(hotels.A)}/instances/${instances.aFias}/commission`)
        .set('X-Test-Actor', gm())
        .send({ evidenceRef: 'Interface Sheet comparison #1' })
        .expect(200);
      await http()
        .post(`${cap(hotels.A)}/instances/${instances.aFias}/commission`)
        .set('X-Test-Actor', gm())
        .send({ evidenceRef: 'again' })
        .expect(409);
      const a = await view(hotels.A);
      expect(of(a, 'CHECKIN_EVENT')).toMatchObject({ effective: false });
      expect(of(a, 'ROOM_STATUS_WRITE')).toMatchObject({ effective: true });
      await verify(hotels.A, 'CHECKIN_EVENT', instances.aFias!);
      expect(of(await view(hotels.A), 'CHECKIN_EVENT')).toMatchObject({ effective: true });
      // Un-verifying needs a reason and is kept in the history.
      await http()
        .post(`${cap(hotels.A)}/capabilities/CHECKIN_EVENT/unverify`)
        .set('X-Test-Actor', gm())
        .send({ instanceId: instances.aFias, reason: 'GI records stopped arriving' })
        .expect(200);
      const history = await http()
        .get(`${cap(hotels.A)}/capabilities/history`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(
        (history.body as Array<{ action: string; capability: string | null }>)
          .slice(0, 4)
          .map((h) => `${h.action}:${h.capability ?? '-'}`),
      ).toEqual([
        'UNVERIFIED:CHECKIN_EVENT',
        'VERIFIED:CHECKIN_EVENT',
        'COMMISSIONED:-',
        'VERIFIED:ROOM_STATUS_WRITE',
      ]);
    });

    it('reorders an operation only within its standard connectors', async () => {
      const bad = await http()
        .put(`${cap(hotels.B)}/routing/SET_ROOM_STATUS`)
        .set('X-Test-Actor', gm())
        .send({ connectors: ['OPERA5_FIAS', 'SIM_PMS', 'OPERA5_FIAS'] })
        .expect(422);
      expect(bad.body.code).toBe('integration.routing.duplicate');
      const notAllowed = await http()
        .put(`${cap(hotels.B)}/routing/ROOM_INVENTORY`)
        .set('X-Test-Actor', gm())
        .send({ connectors: ['OPERA5_OWS'] })
        .expect(422);
      expect(notAllowed.body.code).toBe('integration.routing.not_allowed');
      await http()
        .put(`${cap(hotels.B)}/routing/NOPE`)
        .set('X-Test-Actor', gm())
        .send({ connectors: [] })
        .expect(404);
      const set = await http()
        .put(`${cap(hotels.B)}/routing/SET_ROOM_STATUS`)
        .set('X-Test-Actor', gm())
        .send({ connectors: ['OPERA5_OWS'] })
        .expect(200);
      // OWS cannot write room statuses at this hotel, so nothing is routed — never a silent fallback to FIAS.
      expect(set.body).toMatchObject({ override: ['OPERA5_OWS'], route: [] });
      await http()
        .put(`${cap(hotels.B)}/routing/SET_ROOM_STATUS`)
        .set('X-Test-Actor', gm())
        .send({ connectors: [] })
        .expect(200);
      expect(routeOf(await view(hotels.B), 'SET_ROOM_STATUS')).toEqual(['OPERA5_FIAS']);
    });

    it('connectors of one PMS share its ids: a reservation known through OWS resolves through FIAS', async () => {
      const api = app.get<IntegrationsPublicApi>(INTEGRATIONS_API);
      const ref = (instanceId: string, internalEntityId: string) =>
        api.linkReference({
          tenantId: tenant,
          integrationInstanceId: instanceId,
          internalEntityType: 'guest.stay',
          internalEntityId,
          externalEntityType: 'RESERVATION',
          externalId: `R-${stamp}`,
        });
      const stay = '01900000-0000-7000-8000-00000000000a';
      expect(await ref(instances.bOws!, stay)).toBe(stay);
      expect(
        await api.resolveReference(tenant, instances.bFias!, 'RESERVATION', `R-${stamp}`),
      ).toBe(stay);
      // FIAS links the same reservation to a stay of its own: the family's first holder wins.
      expect(await ref(instances.bFias!, '01900000-0000-7000-8000-00000000000b')).toBe(stay);
      // Another property, or a connector outside the family, is another namespace.
      expect(
        await api.resolveReference(tenant, instances.aFias!, 'RESERVATION', `R-${stamp}`),
      ).toBeNull();
      expect(
        await api.resolveReference(tenant, instances.cSim!, 'RESERVATION', `R-${stamp}`),
      ).toBeNull();
    });

    it('commissioning: the sheet keeps its history, a run without an agent fails, the checklist says why', async () => {
      const base = `${cap(hotels.B)}/commissioning`;
      const put = (requirement: string, body: object) =>
        http().put(`${base}/sheet/${requirement}`).set('X-Test-Actor', gm()).send(body);
      await put('FIAS_DATABASE_SWAP', {
        status: 'CHANGE_REQUIRED',
        hotelValue: 'swap disabled for this interface',
        note: 'asked the IFC8 administrator',
      }).expect(200);
      await put('FIAS_DATABASE_SWAP', { status: 'MATCH', hotelValue: 'enabled' }).expect(200);
      expect((await put('NOT_A_ROW', { status: 'MATCH' }).expect(404)).body.code).toBe(
        'integration.commissioning.unknown_requirement',
      );
      await put('FIAS_CHARSET', { status: 'PERHAPS' }).expect(400);
      const history = (
        await http().get(`${base}/sheet/history`).set('X-Test-Actor', gm()).expect(200)
      ).body as Array<{ requirement: string; status: string }>;
      expect(
        history.filter((r) => r.requirement === 'FIAS_DATABASE_SWAP').map((r) => r.status),
      ).toEqual(['MATCH', 'CHANGE_REQUIRED']);
      // History is kept by the database too: a statement is never edited, a new one is added.
      await expect(
        db.execute(
          sql`update integration.commissioning_sheet_rows set status = 'GAP' where property_id = ${hotels.B}`,
        ),
      ).rejects.toThrow();

      const run = (
        await http()
          .post(`${base}/runs`)
          .set('X-Test-Actor', gm())
          .send({ instanceId: instances.bOws, sample: { confirmationNumber: 'C1' } })
          .expect(200)
      ).body as {
        status: string;
        connectorCode: string;
        checks: Array<{ code: string; outcome: string }>;
      };
      expect(run).toMatchObject({ status: 'FAILED', connectorCode: 'OPERA5_OWS' });
      expect(run.checks.map((c) => [c.code, c.outcome])).toEqual([
        ['AGENT_LINK', 'FAIL'],
        ['HEALTH', 'FAIL'],
        ['ARRIVALS_TOMORROW', 'SKIPPED'],
        ['SAMPLE_RESERVATION', 'SKIPPED'],
      ]);

      const view = (await http().get(base).set('X-Test-Actor', gm()).expect(200)).body as {
        ready: boolean;
        checklist: Array<{ item: string; state: string; reasons: Array<{ code: string }> }>;
        sheet: Array<{
          requirement: string;
          current: { status: string; hotelValue: string } | null;
        }>;
        instances: Array<{
          id: string;
          lastRun: { status: string } | null;
          profileGaps: Array<{ record: string; received: number }> | null;
        }>;
      };
      expect(view.ready).toBe(false);
      expect(view.sheet.find((r) => r.requirement === 'FIAS_DATABASE_SWAP')!.current).toMatchObject(
        {
          status: 'MATCH',
          hotelValue: 'enabled',
        },
      );
      expect(view.instances.find((i) => i.id === instances.bOws)!.lastRun).toMatchObject({
        status: 'FAILED',
      });
      expect(view.instances.find((i) => i.id === instances.bOws)!.profileGaps).toBeNull();
      expect(view.instances.find((i) => i.id === instances.bFias)!.profileGaps).toEqual(
        expect.arrayContaining([expect.objectContaining({ record: 'GI', received: 0 })]),
      );
      const item = (code: string) => view.checklist.find((i) => i.item === code)!;
      expect(item('OWS_KNOWN').state).toBe('OPEN');
      expect(item('DB_ACCOUNT').state).toBe('NOT_APPLICABLE');
      expect(item('VERIFICATION_RUNS').reasons).toEqual(
        expect.arrayContaining([
          { code: 'RUN_FAILED', subject: 'OPERA5_OWS' },
          { code: 'NO_RUN', subject: 'OPERA5_FIAS' },
        ]),
      );
    });

    it('never shows or changes another tenant’s registry', async () => {
      const stranger = user('other', other);
      await http()
        .get(`${cap(hotels.A)}/capabilities`)
        .set('X-Test-Actor', stranger)
        .expect(404);
      await http()
        .post(`${cap(hotels.A)}/capabilities/ROOM_STATUS_WRITE/verify`)
        .set('X-Test-Actor', stranger)
        .send({ instanceId: instances.aFias, evidenceRef: 'nope nope' })
        .expect(404);
      expect(await pms.can(other, hotels.A, 'ROOM_STATUS_WRITE')).toBe(false);
      // An instance of another property of the same tenant is not this property's.
      await http()
        .post(`${cap(hotels.C)}/capabilities/ROOM_STATUS_WRITE/verify`)
        .set('X-Test-Actor', gm())
        .send({ instanceId: instances.aFias, evidenceRef: 'wrong hotel' })
        .expect(404);
      // Profile coverage: another tenant, or another property's instance, is not found.
      await http()
        .get(`${cap(hotels.A)}/instances/${instances.aFias}/profile`)
        .set('X-Test-Actor', stranger)
        .expect(404);
      await http()
        .get(`${cap(hotels.C)}/instances/${instances.aFias}/profile`)
        .set('X-Test-Actor', gm())
        .expect(404);
      const own = await http()
        .get(`${cap(hotels.A)}/instances/${instances.aFias}/profile`)
        .set('X-Test-Actor', gm())
        .expect(200);
      expect(own.body.profile).toEqual({ code: 'PLANOVA_FIAS_STANDARD', version: 1 });
      // Commissioning: another tenant sees nothing; an instance of another property is not this property's.
      await http()
        .get(`${cap(hotels.B)}/commissioning`)
        .set('X-Test-Actor', stranger)
        .expect(404);
      await http()
        .put(`${cap(hotels.B)}/commissioning/sheet/SITE_ROLLBACK`)
        .set('X-Test-Actor', stranger)
        .send({ status: 'MATCH' })
        .expect(404);
      await http()
        .post(`${cap(hotels.C)}/commissioning/runs`)
        .set('X-Test-Actor', gm())
        .send({ instanceId: instances.bOws })
        .expect(404);
    });
  },
);
