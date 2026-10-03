import 'reflect-metadata';
import { type INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
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
import { StaysController } from './api/controllers';
import { StayProjector } from './application/stay-projector';
import { GuestModule, projectOnce } from './guest.module';
import { roomAssignments, stays } from './infrastructure/schema';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], value);
const PERMS = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'integration.read',
  'integration.configure',
  'integration.mapping.confirm',
  'guest.read',
  'guest.manage',
  'guest.merge',
  'guest.data_request.manage',
  'stay.read',
];

describe.skipIf(needsInfra())(`Guest & Stay against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  let app: INestApplication;
  let db: Database;
  let ingest: IngestService;
  let project: ReturnType<typeof projectOnce>;
  let tenantA: string;
  let tenantB: string;
  let propertyA: string;
  let instanceId: string;
  const rooms: Record<string, string> = {};
  const grants: Record<string, string[]> = { gm: PERMS, other: PERMS };
  let seq = 0;
  const http = () => request(app.getHttpServer());
  const gm = () => user('gm', tenantA);
  const base = () => `/properties/${propertyA}`;

  const send = (message_type: string, payload: unknown, id = `${stamp}-${++seq}`) =>
    ingest.ingest(instanceId, { message_type, source_message_id: id, sequence_no: seq, payload });
  const fias = (record: string, id?: string) => send('FIAS_RECORD', { record }, id);
  const ows = (payload: unknown) => send('OWS_RESERVATION', payload);

  /** Delivers every canonical event of the tenant to the projector, as the worker would (duplicates are no-ops). */
  async function drain(): Promise<string[]> {
    const rows = await db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, tenantA),
          like(eventsSchema.outbox.eventType, 'hotel.%'),
        ),
      )
      .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
    const outcomes: string[] = [];
    for (const r of rows) outcomes.push(await project(r.envelope as EventEnvelope));
    return outcomes;
  }
  const guestNamed = async (givenName: string) => {
    const r = await http().get(`${base()}/guests`).set('X-Test-Actor', gm()).expect(200);
    return (r.body as Array<{ id: string; givenName: string }>).find(
      (g) => g.givenName === givenName,
    )!.id;
  };
  const guestEvents = (type: string) =>
    db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(eq(eventsSchema.outbox.tenantId, tenantA), eq(eventsSchema.outbox.eventType, type)),
      )
      .orderBy(asc(eventsSchema.outbox.createdAt));
  const stayByConfirmation = async (confirmation: string) => {
    const list = await http().get(`${base()}/stays`).set('X-Test-Actor', gm()).expect(200);
    for (const s of list.body as Array<{ id: string }>) {
      const detail = await http().get(`${base()}/stays/${s.id}`).set('X-Test-Actor', gm());
      const refs = detail.body.references as Array<{ confirmationNumber: string | null }>;
      if (refs.some((r) => r.confirmationNumber === confirmation)) return detail.body;
    }
    return null;
  };

  beforeAll(async () => {
    await runMigrations(url);
    const env = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: await applicationRoleUrl(url, 'hotella_app_guest'),
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

    tenantA = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `gst-a-${stamp}`, name: 'A' })
        .expect(201)
    ).body.id;
    tenantB = (
      await http()
        .post('/tenants')
        .set('X-Test-Actor', admin)
        .send({ code: `gst-b-${stamp}`, name: 'B' })
        .expect(201)
    ).body.id;
    propertyA = (
      await http()
        .post('/properties')
        .set('X-Test-Actor', gm())
        .send({ code: 'HRG', name: 'Hurghada', timezone: 'Africa/Cairo', currency: 'EGP' })
        .expect(201)
    ).body.id;
    const tree = await http().get(`${base()}/locations`).set('X-Test-Actor', gm()).expect(200);
    const root = Array.isArray(tree.body) ? tree.body[0].id : tree.body.id;
    for (const n of ['504', '505', '506']) {
      rooms[n] = (
        await http()
          .post(`${base()}/rooms`)
          .set('X-Test-Actor', gm())
          .send({ parentId: root, roomNumber: n })
          .expect(201)
      ).body.locationId;
    }
    instanceId = (
      await http()
        .post(`${base()}/integrations`)
        .set('X-Test-Actor', gm())
        .send({
          connectorCode: 'SIM_PMS',
          name: 'Simulator',
          capabilities: [
            'CHECKIN_EVENT',
            'CHECKOUT_EVENT',
            'ROOM_MOVE_EVENT',
            'PROFILE_EVENT',
            'RESERVATION_READ',
            'GUEST_READ',
          ],
        })
        .expect(201)
    ).body.id;
    await http()
      .patch(`${base()}/integrations/${instanceId}`)
      .set('X-Test-Actor', gm())
      .send({ version: 1, status: 'ACTIVE' })
      .expect(200);
    await http()
      .post(`${base()}/integrations/${instanceId}/mappings/rooms-by-number`)
      .set('X-Test-Actor', gm())
      .expect(200);
  });
  afterAll(() => app?.close());

  it('a future reservation becomes an EXPECTED stay with its party and pre-assigned room', async () => {
    const r = await ows({
      action: 'NEW',
      modifiedAt: '2026-10-01T08:00:00Z',
      reservation: {
        reservationId: `R1-${stamp}`,
        confirmationNo: `C1-${stamp}`,
        arrivalDate: '2026-10-03',
        departureDate: '2026-10-06',
        adults: 2,
        roomNumber: '504',
        guest: {
          profileId: `P1-${stamp}`,
          firstName: 'Amira',
          lastName: 'Nile',
          language: 'ar',
          email: 'Amira.Nile@Example.com',
          phone: '+20 100 123 4567',
        },
        sharers: [{ firstName: 'Omar', lastName: 'Nile' }],
      },
    });
    expect(r.status).toBe('PROCESSED');
    expect(await drain()).toContain('processed');
    const stay = await stayByConfirmation(`C1-${stamp}`);
    expect(stay).toMatchObject({ status: 'EXPECTED', adults: 2, expectedDeparture: '2026-10-06' });
    expect(stay.party).toHaveLength(2);
    expect(stay.currentRoom).toMatchObject({ roomNumber: '504', reason: 'PRE_ASSIGNMENT' });
    const created = await guestEvents('guest.stay.created');
    expect(created.length).toBeGreaterThanOrEqual(1);
  });

  it('check-in moves the stay in house; delivering the same event again changes nothing', async () => {
    const gi = await fias(
      `GI|RN505|G#R1-${stamp}|GNNile|GFAmira|GLar|GA261003|GD261006|DA261003|TI150000|`,
      `gi-${stamp}`,
    );
    expect(gi.status).toBe('PROCESSED');
    const outcomes = await drain();
    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(await drain()).not.toContain('processed');
    expect((await fias('GI|RN505|', `gi-${stamp}`)).outcome).toBe('duplicate');

    const stay = await stayByConfirmation(`C1-${stamp}`);
    expect(stay.status).toBe('IN_HOUSE');
    expect(stay.actualCheckinAt).toBe('2026-10-03T12:00:00.000Z');
    expect(
      stay.roomAssignments.map((a: { roomNumber: string; reason: string }) => [
        a.roomNumber,
        a.reason,
      ]),
    ).toEqual([
      ['504', 'PRE_ASSIGNMENT'],
      ['505', 'INITIAL'],
    ]);
    // The FIAS snapshot names the same primary guest; the party keeps one Amira (no duplicate guest).
    expect(stay.party.filter((m: { leftAt: string | null }) => m.leftAt === null)).toHaveLength(1);
    const status = await guestEvents('guest.stay.status_changed');
    expect(at(status.at(-1)!.envelope, 'payload')).toMatchObject({
      from: 'EXPECTED',
      to: 'IN_HOUSE',
      room_id: rooms['505'],
    });
  });

  it('a room move keeps history and flips the room lookup', async () => {
    await http()
      .get(`${base()}/rooms/${rooms['505']}/current-stay`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect((await fias(`GC|RN506|RO505|G#R1-${stamp}|DA261004|TI100000|`)).status).toBe(
      'PROCESSED',
    );
    await drain();
    const stay = await stayByConfirmation(`C1-${stamp}`);
    expect(stay.roomAssignments).toHaveLength(3);
    expect(stay.currentRoom).toMatchObject({ roomNumber: '506', reason: 'ROOM_MOVE' });
    const open = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(roomAssignments)
      .where(
        and(eq(roomAssignments.stayId, stay.id), sql`${roomAssignments.unassignedAt} is null`),
      );
    expect(open[0]!.n).toBe(1);
    const nowIn506 = await http()
      .get(`${base()}/rooms/${rooms['506']}/current-stay`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(nowIn506.body).toMatchObject({ id: stay.id, room: { roomNumber: '506' } });
    const r505 = await http()
      .get(`${base()}/rooms/${rooms['505']}/current-stay`)
      .set('X-Test-Actor', gm())
      .expect(404);
    expect(r505.body.code).toBe('guest.stay.not_in_room');
  });

  it('an older reservation snapshot arriving late never overwrites newer facts', async () => {
    await ows({
      action: 'CHANGE',
      modifiedAt: '2026-10-02T08:00:00Z',
      reservation: {
        reservationId: `R1-${stamp}`,
        arrivalDate: '2026-10-03',
        departureDate: '2026-10-09',
        guest: { profileId: `P1-${stamp}`, firstName: 'Amira', lastName: 'Nile' },
      },
    });
    await drain();
    const stay = await stayByConfirmation(`C1-${stamp}`);
    expect(stay).toMatchObject({ status: 'IN_HOUSE', expectedDeparture: '2026-10-06' });
    expect(stay.currentRoom.roomNumber).toBe('506');
  });

  it('check-out closes the stay and its room assignment and announces it', async () => {
    expect((await fias(`GO|RN506|G#R1-${stamp}|DA261006|TI113000|`)).status).toBe('PROCESSED');
    await drain();
    const stay = await stayByConfirmation(`C1-${stamp}`);
    expect(stay).toMatchObject({ status: 'CHECKED_OUT', currentRoom: null });
    expect(stay.actualCheckoutAt).toBe('2026-10-06T08:30:00.000Z');
    expect(stay.roomAssignments.every((a: { unassignedAt: string | null }) => a.unassignedAt)).toBe(
      true,
    );
    await http()
      .get(`${base()}/rooms/${rooms['506']}/current-stay`)
      .set('X-Test-Actor', gm())
      .expect(404);
    const status = await guestEvents('guest.stay.status_changed');
    expect(at(status.at(-1)!.envelope, 'payload')).toMatchObject({
      to: 'CHECKED_OUT',
      room_id: rooms['506'],
    });
    // A late duplicate check-in from before the check-out does not re-open the stay.
    await fias(`GI|RN506|G#R1-${stamp}|GNNile|GFAmira|GD261006|DA261003|TI150500|`);
    await drain();
    expect((await stayByConfirmation(`C1-${stamp}`)).status).toBe('CHECKED_OUT');
  });

  it('walk-ins, profile changes and cancellations follow the PMS', async () => {
    await fias(`GI|RN504|G#W1-${stamp}|GNStone|GFLina|GLen|GD261008|DA261005|TI200000|`);
    await fias(`GC|RN504|G#W1-${stamp}|GNStone|GFLina|GLar|`);
    await ows({
      action: 'NEW',
      modifiedAt: '2026-10-02T08:00:00Z',
      reservation: {
        reservationId: `R3-${stamp}`,
        confirmationNo: `C3-${stamp}`,
        arrivalDate: '2026-10-20',
        departureDate: '2026-10-22',
        guest: { firstName: 'Karim' },
      },
    });
    await ows({
      action: 'CANCEL',
      modifiedAt: '2026-10-03T08:00:00Z',
      reservation: { reservationId: `R3-${stamp}` },
    });
    await drain();
    const inHouse = await http()
      .get(`${base()}/stays?status=IN_HOUSE`)
      .set('X-Test-Actor', gm())
      .expect(200);
    const walkIn = (
      inHouse.body as Array<{ primaryGuest: { givenName: string; primaryLocale: string } }>
    ).find((s) => s.primaryGuest.givenName === 'Lina');
    expect(walkIn?.primaryGuest.primaryLocale).toBe('ar');
    expect((await stayByConfirmation(`C3-${stamp}`)).status).toBe('CANCELLED');
  });

  it('guest profiles are visible only through a stay at the property, with masked contacts', async () => {
    const search = await http()
      .get(`${base()}/guests?q=nile`)
      .set('X-Test-Actor', gm())
      .expect(200);
    const amira = (search.body as Array<{ id: string; givenName: string }>).find(
      (g) => g.givenName === 'Amira',
    )!;
    const detail = await http()
      .get(`${base()}/guests/${amira.id}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(detail.body.identifiers).toEqual(
      expect.arrayContaining([
        { kind: 'EMAIL', value: 'a***@example.com', verified: false },
        { kind: 'PHONE', value: '+20********67', verified: false },
      ]),
    );
    expect(detail.body.stays).toHaveLength(1);
    await http()
      .get(`${base()}/guests/${amira.id}`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(404);
    await http().get(`${base()}/stays`).set('X-Test-Actor', user('other', tenantB)).expect(404);
  });

  it('staff keep preferences and an append-only consent history', async () => {
    const amira = await guestNamed('Amira');
    const g = `${base()}/guests/${amira}`;
    await http()
      .put(`${g}/preferences`)
      .set('X-Test-Actor', gm())
      .send({ category: 'room', key: 'pillow', value: 'firm' })
      .expect(200);
    const inferred = await http()
      .put(`${g}/preferences`)
      .set('X-Test-Actor', gm())
      .send({ category: 'dining', key: 'diet', value: 'vegetarian', source: 'INFERRED' })
      .expect(400);
    expect(inferred.body.code).toBe('platform.validation_failed');
    const prefs = await http().get(`${g}/preferences`).set('X-Test-Actor', gm()).expect(200);
    expect(prefs.body).toMatchObject([
      { category: 'room', key: 'pillow', value: 'firm', confidence: 100 },
    ]);

    for (const granted of [true, false])
      await http()
        .post(`${g}/consents`)
        .set('X-Test-Actor', gm())
        .send({ type: 'MARKETING_EMAIL', granted, channel: 'FRONT_DESK', evidence: { form: 'v1' } })
        .expect(201);
    const consents = await http().get(`${g}/consents`).set('X-Test-Actor', gm()).expect(200);
    expect(consents.body.current).toMatchObject([{ type: 'MARKETING_EMAIL', granted: false }]);
    expect(consents.body.history).toHaveLength(2);
    // The database refuses to rewrite or delete consent history.
    const dbError = (fn: () => Promise<unknown>) =>
      fn().then(
        () => 'no error',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
      );
    expect(
      await dbError(() =>
        db.execute(sql`update guest.guest_consents set granted = true where guest_id = ${amira}`),
      ),
    ).toMatch(/immutable/);
    expect(
      await dbError(() =>
        db.execute(sql`delete from guest.guest_consents where guest_id = ${amira}`),
      ),
    ).toMatch(/append-only/);
  });

  it('merges a duplicate walk-in profile into the surviving guest', async () => {
    // The same person checks in twice under separate reservations without a PMS profile id: two guests.
    await fias(`GI|RN505|G#W2-${stamp}|GNStone|GFLina|GD261008|DA261005|TI210000|`);
    await drain();
    const search = await http()
      .get(`${base()}/guests?q=stone`)
      .set('X-Test-Actor', gm())
      .expect(200);
    const linas = (search.body as Array<{ id: string }>).map((g) => g.id);
    expect(linas).toHaveLength(2);
    const [survivor, duplicate] = linas as [string, string];
    await http()
      .post(`${base()}/guests/${duplicate}/merge`)
      .set('X-Test-Actor', gm())
      .send({ intoGuestId: duplicate, reason: 'same passport' })
      .expect(422);
    const merged = await http()
      .post(`${base()}/guests/${duplicate}/merge`)
      .set('X-Test-Actor', gm())
      .send({ intoGuestId: survivor, reason: 'same passport, confirmed at the desk' })
      .expect(200);
    expect(merged.body.moved.primaryStays).toBe(1);
    const after = await http()
      .get(`${base()}/guests?q=stone`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect((after.body as Array<{ id: string }>).map((g) => g.id)).toEqual([survivor]);
    const detail = await http()
      .get(`${base()}/guests/${survivor}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(detail.body.stays).toHaveLength(2);
    // The merged tombstone is no longer reachable through a stay at the property.
    await http()
      .post(`${base()}/guests/${duplicate}/merge`)
      .set('X-Test-Actor', gm())
      .send({ intoGuestId: survivor, reason: 'again' })
      .expect(404);
    const tombstone = await db.execute<{ status: string; merged_into_guest_id: string }>(
      sql`select status, merged_into_guest_id from guest.guests where id = ${duplicate}`,
    );
    expect(tombstone.rows[0]).toEqual({ status: 'MERGED', merged_into_guest_id: survivor });
  });

  it('exports and anonymizes on request while stays, room history and audit remain', async () => {
    const amira = await guestNamed('Amira');
    const g = `${base()}/guests/${amira}`;
    const exported = await http()
      .post(`${g}/data-requests`)
      .set('X-Test-Actor', gm())
      .send({ kind: 'EXPORT', reason: 'guest asked by e-mail' })
      .expect(201);
    expect(exported.body.export.identifiers).toEqual(
      expect.arrayContaining([{ kind: 'EMAIL', value: 'amira.nile@example.com', verified: false }]),
    );
    expect(exported.body.request.result.sha256).toMatch(/^[0-9a-f]{64}$/);

    const lina = (
      (await http().get(`${base()}/guests?q=stone`).set('X-Test-Actor', gm()).expect(200))
        .body as Array<{ id: string }>
    )[0]!.id;
    const busy = await http()
      .post(`${base()}/guests/${lina}/data-requests`)
      .set('X-Test-Actor', gm())
      .send({ kind: 'ANONYMIZE', reason: 'guest asked' })
      .expect(409);
    expect(busy.body.code).toBe('guest.guest.active_stay');

    const anonymized = await http()
      .post(`${g}/data-requests`)
      .set('X-Test-Actor', gm())
      .send({ kind: 'DELETE', reason: 'erasure request ticket 42' })
      .expect(201);
    expect(anonymized.body.request.result).toMatchObject({
      identifiers: 2,
      preferences: 1,
      unlinkedProfiles: 1,
    });
    expect(anonymized.body.request.result.scrubbedMessages).toBeGreaterThan(0);

    const detail = await http().get(g).set('X-Test-Actor', gm()).expect(200);
    expect(detail.body).toMatchObject({
      givenName: 'ANONYMIZED',
      familyName: null,
      status: 'ANONYMIZED',
    });
    expect(detail.body.identifiers).toEqual([]);
    const stay = await stayByConfirmation(`C1-${stamp}`);
    expect(stay).toMatchObject({ status: 'CHECKED_OUT' });
    expect(stay.roomAssignments).toHaveLength(3);
    // No trace of the guest's name in raw vendor messages or in the append-only audit log.
    const raw = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from integration.integration_messages
            where tenant_id = ${tenantA} and payload::text like ${'%Amira%'}`,
    );
    expect(raw.rows[0]!.n).toBe(0);
    const audit = await db.execute<{ n: number; total: number }>(
      sql`select count(*) filter (where coalesce(before::text,'') || coalesce(after::text,'') like ${'%Amira%'})::int as n,
                 count(*)::int as total
            from audit.audit_log where tenant_id = ${tenantA}`,
    );
    expect(audit.rows[0]!.n).toBe(0);
    expect(audit.rows[0]!.total).toBeGreaterThan(5);
    await http()
      .post(`${g}/data-requests`)
      .set('X-Test-Actor', gm())
      .send({ kind: 'ANONYMIZE', reason: 'again' })
      .expect(409);
  });

  it('stays change only through PMS events: the staff API has no mutating route', () => {
    const proto = StaysController.prototype as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(proto)
      .filter((k) => k !== 'constructor')
      .map((k) => Reflect.getMetadata(METHOD_METADATA, proto[k] as object) as RequestMethod);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === RequestMethod.GET)).toBe(true);
  });

  it('PMS ids never become guest identifiers or keys', async () => {
    const cols = await db.execute<{ table_name: string; column_name: string; data_type: string }>(
      sql`select table_name, column_name, data_type from information_schema.columns where table_schema = 'guest'`,
    );
    // Entity keys and references (actor references `*_by_id` name who acted, not an entity).
    const ids = cols.rows.filter(
      (c) =>
        (c.column_name === 'id' || c.column_name.endsWith('_id')) &&
        !c.column_name.endsWith('_by_id'),
    );
    expect(ids.length).toBeGreaterThan(10);
    // Every id-like column is a UUID minted by Hotella, so a vendor id cannot be stored as one.
    expect(ids.filter((c) => c.data_type !== 'uuid')).toEqual([]);
    expect(
      cols.rows.some((c) => /external|reservation_number|profile_id/.test(c.column_name)),
    ).toBe(false);
    const sample = await db.select({ id: stays.id }).from(stays).where(eq(stays.tenantId, tenantA));
    expect(sample.every((s) => /^[0-9a-f-]{36}$/.test(s.id))).toBe(true);
  });
});
