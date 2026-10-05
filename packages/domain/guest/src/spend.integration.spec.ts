import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { IngestService, IntegrationsModule } from '@hotella/domain-integrations';
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
import { EventsModule, eventsSchema, IdempotentConsumer } from '@hotella/platform-events';
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
import { StayProjector } from './application/stay-projector';
import { StaySpendService } from './application/spend.service';
import { GuestModule, projectOnce, recordSpendOnce } from './guest.module';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const PERMS = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'integration.read',
  'integration.configure',
  'integration.mapping.confirm',
  'stay.read',
];

/**
 * POS spend (BUILD_PLAN 13.5): closed checks from the neutral POS connector wait for their outlet mapping (never
 * guessed), become `hotel.pos.check_closed`, and the guest context ties each to the stay by reservation reference or by
 * the room at closing time. Walk-ins and shared rooms stay untied; the same check twice is one fact.
 */
describe.skipIf(needsInfra())(`POS spend of stays (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let ingest: IngestService;
  let project: ReturnType<typeof projectOnce>;
  let spend: ReturnType<typeof recordSpendOnce>;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  let pms: string;
  let pos: string;
  let stayId: string;
  const grants: Record<string, string[]> = { gm: PERMS, other: PERMS };
  let seq = 0;
  const http = () => request(app.getHttpServer());
  const as = (id: string, tenantId = tenantA) => user(id, tenantId);
  const base = () => `/properties/${propertyA}`;
  const send = (
    instance: string,
    message_type: string,
    payload: unknown,
    id = `${stamp}-${++seq}`,
  ) =>
    ingest.ingest(instance, { message_type, source_message_id: id, sequence_no: ++seq, payload });
  const rows = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as unknown as T[];
  const outbox = (prefix: string) =>
    db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(eq(eventsSchema.outbox.tenantId, tenantA), like(eventsSchema.outbox.eventType, prefix)),
      )
      .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
  /** The worker: stay projector for PMS events, then the spend consumer for POS checks (each event once). */
  async function drain(): Promise<void> {
    for (const r of await outbox('hotel.%')) {
      const envelope = r.envelope as EventEnvelope;
      if (r.eventType === 'hotel.pos.check_closed') await spend(envelope);
      else await project(envelope);
    }
  }
  const check = (id: string, extra: Record<string, unknown>) =>
    send(
      pos,
      'POS_CHECK',
      {
        check_id: id,
        outlet: 'OUT-REST',
        closed_at: new Date().toISOString(),
        total_minor: 120000,
        currency: 'EGP',
        settlement: 'ROOM_CHARGE',
        ...extra,
      },
      id,
    );
  const spendOf = async () =>
    (await http().get(`${base()}/stays/${stayId}/spend`).set('X-Test-Actor', as('gm')).expect(200))
      .body as {
      totals: Array<{
        outletCategory: string;
        settlement: string;
        totalMinor: number;
        checks: number;
      }>;
      checks: unknown[];
    };

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_pos_spend'),
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
            useValue: new StaticPermissionResolver(grants),
          },
          propertyVerifier: OrganizationModule.propertyVerifier(),
          stages: [IntegrationsModule.capabilityStage()],
        }),
        OrganizationModule,
        IntegrationsModule,
        GuestModule,
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
    db = app.get(DATABASE);
    ingest = app.get(IngestService);
    project = projectOnce(app.get(IdempotentConsumer), app.get(StayProjector));
    spend = recordSpendOnce(app.get(IdempotentConsumer), app.get(StaySpendService));

    for (const code of ['a', 'b']) {
      const id = (
        await http()
          .post('/tenants')
          .set('X-Test-Actor', admin)
          .send({ code: `pos-${code}-${stamp}`, name: code })
          .expect(201)
      ).body.id as string;
      if (code === 'a') tenantA = id;
      else tenantB = id;
    }
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', as('gm'))
        .send({ code: 'POS', name: 'Spend', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id;
    const tree = await http().get(`${base()}/locations`).set('X-Test-Actor', as('gm')).expect(200);
    const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
    for (const n of ['214', '215'])
      await http()
        .post(`${base()}/rooms`)
        .set('X-Test-Actor', as('gm'))
        .send({ parentId: root, roomNumber: n })
        .expect(201);
    const instance = async (connectorCode: string, capabilities: string[]) => {
      const id = (
        await http()
          .post(`${base()}/integrations`)
          .set('X-Test-Actor', as('gm'))
          .send({ connectorCode, name: connectorCode, capabilities })
          .expect(201)
      ).body.id as string;
      await http()
        .patch(`${base()}/integrations/${id}`)
        .set('X-Test-Actor', as('gm'))
        .send({ version: 1, status: 'ACTIVE' })
        .expect(200);
      await http()
        .post(`${base()}/integrations/${id}/mappings/rooms-by-number`)
        .set('X-Test-Actor', as('gm'))
        .expect(200);
      return id;
    };
    pms = await instance('SIM_PMS', ['CHECKIN_EVENT', 'CHECKOUT_EVENT', 'RESERVATION_READ']);
    pos = await instance('POS_STANDARD', ['CHECK_READ']);
    await send(pms, 'FIAS_RECORD', {
      record: `GI|RN214|G#P1-${stamp}|GNStone|GFLina|GD261009|DA261005|TI150000|`,
    });
    await drain();
    stayId = (
      await rows<{ stay_id: string }>(
        sql`select r.stay_id from guest.reservation_references r join guest.stays s on s.id = r.stay_id where s.tenant_id = ${tenantA}`,
      )
    )[0]!.stay_id;
  });
  afterAll(() => app?.close());

  it('a check waits for its outlet mapping, which only takes a known category', async () => {
    const first = await check(`CHK-1-${stamp}`, { room: '214', covers: 2 });
    expect(first.status).toBe('PENDING_MAPPING');
    const bad = await http()
      .post(`${base()}/integrations/${pos}/mappings`)
      .set('X-Test-Actor', as('gm'))
      .send({ mappingType: 'OUTLET', externalCode: 'OUT-REST', internalValue: 'CASINO' })
      .expect(422);
    expect(bad.body.code).toBe('integration.mapping.invalid_outlet');
    await http()
      .post(`${base()}/integrations/${pos}/mappings`)
      .set('X-Test-Actor', as('gm'))
      .send({ mappingType: 'OUTLET', externalCode: 'OUT-REST', internalValue: 'RESTAURANT' })
      .expect(200);
    expect(await ingest.reprocess({ tenantId: tenantA }, first.messageId)).toBe('PROCESSED');
    await drain();
    const s = await spendOf();
    expect(s.totals).toEqual([
      expect.objectContaining({
        outletCategory: 'RESTAURANT',
        settlement: 'ROOM_CHARGE',
        totalMinor: 120000,
        checks: 1,
        covers: 2,
      }),
    ]);
  });

  it('a check names its stay by reservation; the same check twice is one fact; walk-ins stay untied', async () => {
    await http()
      .post(`${base()}/integrations/${pos}/mappings`)
      .set('X-Test-Actor', as('gm'))
      .send({ mappingType: 'OUTLET', externalCode: 'OUT-BAR', internalValue: 'BAR' })
      .expect(200);
    const id = `CHK-2-${stamp}`;
    const payload = {
      outlet: 'OUT-BAR',
      reservation: { external_id: `P1-${stamp}`, confirmation_number: null },
      total_minor: 30000,
      settlement: 'CASH',
    };
    await check(id, payload);
    expect((await check(id, payload)).outcome).toBe('duplicate');
    // A walk-in at the bar, and a check for an empty room: no stay, nothing recorded.
    await check(`CHK-3-${stamp}`, { outlet: 'OUT-BAR', settlement: 'CARD' });
    await check(`CHK-4-${stamp}`, { outlet: 'OUT-BAR', room: '215' });
    await drain();
    const s = await spendOf();
    expect(s.checks).toHaveLength(2);
    expect(s.totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outletCategory: 'BAR', settlement: 'CASH', totalMinor: 30000 }),
      ]),
    );
    const recorded = await outbox('guest.stay_charge.recorded');
    expect(recorded).toHaveLength(2);
    // Internal ids and amounts only: no POS check id, no reservation id.
    expect(JSON.stringify(recorded.map((r) => r.envelope))).not.toContain(`CHK-2-${stamp}`);
    expect(JSON.stringify(recorded.map((r) => r.envelope))).not.toContain(`P1-${stamp}`);
  });

  it('another hotel sees none of it', async () => {
    await http()
      .get(`${base()}/stays/${stayId}/spend`)
      .set('X-Test-Actor', as('other', tenantB))
      .expect(404);
    const leaked = await rows<{ n: number }>(
      sql`select count(*)::int as n from guest.stay_charges where tenant_id = ${tenantB}`,
    );
    expect(leaked[0]!.n).toBe(0);
  });
});
