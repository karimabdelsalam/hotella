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
  newId,
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
import { StayNotYetKnownError, StayProjector } from './application/stay-projector';
import { GuestModule, projectOnce } from './guest.module';
import { roomAssignments, stays } from './infrastructure/schema';
import { GUEST_API, type GuestPublicApi } from './public';

const admin = JSON.stringify({ type: 'USER', id: 'admin', tenantId: null, isPlatformAdmin: true });
const user = (id: string, tenantId: string): string =>
  JSON.stringify({ type: 'USER', id, tenantId, isPlatformAdmin: false });
const stamp = Date.now().toString(36).toUpperCase();
const at = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], value);
/** The database's own message for a refused statement (drizzle wraps it). */
const dbError = (fn: () => Promise<unknown>) =>
  fn().then(
    () => 'no error',
    (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
  );
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
  'guest.grant.revoke',
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

  it('facts delivered before their check-in are retried, and a late check-in never moves the guest back', async () => {
    // The PMS: check-in to 504, a move to 505 an hour later, check-out — delivered to the projector out of order.
    await fias(`GI|RN504|G#X1-${stamp}|GNEast|GFNour|GD261008|DA261005|TI090000|`);
    await fias(`GC|RN505|RO504|G#X1-${stamp}|DA261005|TI100000|`);
    await fias(`GO|RN505|G#X1-${stamp}|DA261008|TI100000|`);
    const of = async (type: string) =>
      (
        await db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.tenantId, tenantA),
              eq(eventsSchema.outbox.eventType, type),
              sql`${eventsSchema.outbox.envelope}::text like ${`%X1-${stamp}%`}`,
            ),
          )
      ).map((r) => r.envelope as EventEnvelope);
    const [checkIn] = await of('hotel.guest.checked_in');
    const [move] = await of('hotel.stay.room_changed');
    const [checkOut] = await of('hotel.guest.checked_out');

    // Before the check-in exists: rejected so the queue retries them, not dropped.
    await expect(project(move!)).rejects.toBeInstanceOf(StayNotYetKnownError);
    await expect(project(checkOut!)).rejects.toBeInstanceOf(StayNotYetKnownError);
    // Long after it was received, an unknown reservation is reported and ignored (reconciliation's job).
    const stale = {
      ...checkOut!,
      event_id: newId(),
      received_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    expect(await project(stale)).toBe('processed');

    // The move arrives (via a pre-existing reservation) before the check-in: the late check-in keeps 505.
    await ows({
      action: 'CHANGE',
      modifiedAt: '2026-10-04T08:00:00Z',
      reservation: {
        reservationId: `X1-${stamp}`,
        arrivalDate: '2026-10-05',
        departureDate: '2026-10-08',
        guest: { profileId: `PX1-${stamp}`, firstName: 'Nour', lastName: 'East' },
      },
    });
    const [reservation] = await of('hotel.reservation.updated');
    expect(await project(reservation!)).toBe('processed');
    expect(await project(move!)).toBe('processed'); // the retry now finds the stay
    expect(await project(checkIn!)).toBe('processed');
    // The stay behind PMS reservation X1 (external ids live only in the integration context).
    const [ref] = (
      await db.execute<{ id: string }>(
        sql`select internal_entity_id as id from integration.external_references
             where external_id = ${`X1-${stamp}`} and internal_entity_type = 'guest.stay'`,
      )
    ).rows;
    const stayOf = async () =>
      (await http().get(`${base()}/stays/${ref!.id}`).set('X-Test-Actor', gm()).expect(200)).body;
    let stay = await stayOf();
    expect(stay.currentRoom).toMatchObject({ roomNumber: '505', reason: 'ROOM_MOVE' });
    expect(stay.status).toBe('IN_HOUSE');
    // …yet the check-in room is not lost: it is history, closed where the move starts (rule 10).
    const history = await db.execute<{ room: string; reason: string; open: boolean }>(
      sql`select r.room_number as room, a.reason, a.unassigned_at is null as open
            from guest.room_assignments a join org.rooms r on r.location_id = a.room_id
           where a.stay_id = ${ref!.id} order by a.assigned_at, a.id`,
    );
    expect(history.rows).toEqual([
      { room: '504', reason: 'INITIAL', open: false },
      { room: '505', reason: 'ROOM_MOVE', open: true },
    ]);
    expect(await project(checkOut!)).toBe('processed');
    stay = await stayOf();
    expect(stay.status).toBe('CHECKED_OUT');
  });

  it('a plan recorded after the check-in it gave way to is not history: any delivery order, the same stay', async () => {
    // The PMS: check-in to 504 on the 5th, a move to 505 an hour later; the reservation (pre-assigned to 506) was
    // last modified only on the 6th. Delivered as the pilot's worker once did: reservation, move, then check-in.
    await fias(`GI|RN504|G#X2-${stamp}|GNWest|GFSara|GD261008|DA261005|TI090000|`);
    await fias(`GC|RN505|RO504|G#X2-${stamp}|DA261005|TI100000|`);
    await ows({
      action: 'NEW',
      modifiedAt: '2026-10-06T03:00:00Z',
      reservation: {
        reservationId: `X2-${stamp}`,
        arrivalDate: '2026-10-05',
        departureDate: '2026-10-08',
        roomNumber: '506',
        guest: { profileId: `PX2-${stamp}`, firstName: 'Sara', lastName: 'West' },
      },
    });
    const of = async (type: string) =>
      (
        await db
          .select()
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.tenantId, tenantA),
              eq(eventsSchema.outbox.eventType, type),
              sql`${eventsSchema.outbox.envelope}::text like ${`%X2-${stamp}%`}`,
            ),
          )
      ).map((r) => r.envelope as EventEnvelope);
    const [reservation] = await of('hotel.reservation.created');
    const [move] = await of('hotel.stay.room_changed');
    const [checkIn] = await of('hotel.guest.checked_in');
    expect(await project(reservation!)).toBe('processed');
    expect(await project(move!)).toBe('processed');
    expect(await project(checkIn!)).toBe('processed');
    const [ref] = (
      await db.execute<{ id: string }>(
        sql`select internal_entity_id as id from integration.external_references
             where external_id = ${`X2-${stamp}`} and internal_entity_type = 'guest.stay'`,
      )
    ).rows;
    const history = await db.execute<{ room: string; reason: string; open: boolean }>(
      sql`select r.room_number as room, a.reason, a.unassigned_at is null as open
            from guest.room_assignments a join org.rooms r on r.location_id = a.room_id
           where a.stay_id = ${ref!.id} order by a.assigned_at, a.id`,
    );
    // What time order gives (the reservation found the guest already in house): no plan to 506.
    expect(history.rows).toEqual([
      { room: '504', reason: 'INITIAL', open: false },
      { room: '505', reason: 'ROOM_MOVE', open: true },
    ]);
  });

  it('guest access follows the stay: pre-arrival, arrival, check-out window, staff revocation', async () => {
    const api = app.get<GuestPublicApi>(GUEST_API);
    // Dates relative to now: grant validity is checked against the real clock.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const fiasDate = (d: Date) => iso(d).slice(2).replaceAll('-', '');
    const fiasTime = (d: Date) => d.toISOString().slice(11, 19).replaceAll(':', '');
    await ows({
      action: 'NEW',
      modifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
      reservation: {
        reservationId: `R7-${stamp}`,
        confirmationNo: `C7-${stamp}`,
        arrivalDate: iso(day(0)),
        departureDate: iso(day(3)),
        adults: 2,
        roomNumber: '504',
        guest: { profileId: `P7-${stamp}`, firstName: 'Mona', lastName: 'Delta' },
        sharers: [{ firstName: 'Ali', lastName: 'Delta' }],
      },
    });
    await drain();
    const stay = await stayByConfirmation(`C7-${stamp}`);
    expect(stay.status).toBe('EXPECTED');
    const primary = stay.party.find((m: { role: string }) => m.role === 'PRIMARY').guest.id;
    const companion = stay.party.find((m: { role: string }) => m.role === 'ACCOMPANYING').guest.id;
    const actor = { type: 'GUEST' as const, id: null };
    const issue = (guestId: string) =>
      api.issueGrant({
        tenantId: tenantA,
        propertyId: propertyA,
        stayId: stay.id,
        guestId,
        via: 'ACTIVATION',
        actor,
      });

    // Before arrival: a pre-arrival grant, reused for a second device; room-specific scopes are not part of it.
    const pre = await issue(primary);
    expect(pre).toMatchObject({ grantedVia: 'PRE_ARRIVAL', partyRole: 'PRIMARY' });
    expect(pre.effectiveScopes).toEqual([
      'SERVICE_REQUEST',
      'CHAT',
      'DINING',
      'CONCIERGE',
      'SUPPORT',
    ]);
    expect((await issue(primary)).id).toBe(pre.id);
    const phone = await api.openGuestSession(tenantA, pre.id, 'phone');
    const tablet = await api.openGuestSession(tenantA, pre.id, 'tablet');
    expect(phone.token).not.toBe(tablet.token);
    expect(await api.authenticateGuestSession(phone.token)).toMatchObject({
      guestId: primary,
      stayId: stay.id,
      grantId: pre.id,
    });
    expect(await api.authenticateGuestSession('not-a-token')).toBeNull();
    const companionGrant = await issue(companion);
    const companionSession = await api.openGuestSession(tenantA, companionGrant.id, null);
    // A guest outside the party gets nothing.
    await expect(issue(await guestNamed('Lina'))).rejects.toMatchObject({
      code: 'guest.grant.not_in_party',
    });

    // Arrival widens both grants: the primary guest gets the bill, the companion does not.
    const arrived = new Date(Date.now() - 120_000);
    await fias(
      `GI|RN505|G#R7-${stamp}|GNDelta|GFMona|GD${fiasDate(day(3))}|DA${fiasDate(arrived)}|TI${fiasTime(arrived)}|`,
    );
    await drain();
    const inHouse = (await api.authenticateGuestSession(phone.token))!;
    expect(inHouse.scopes).toContain('VIEW_BILL');
    expect(inHouse.scopes).toContain('ROOM_CONTROL');
    const comp = (await api.authenticateGuestSession(companionSession.token))!;
    expect(comp.scopes).toContain('ROOM_CONTROL');
    expect(comp.scopes).not.toContain('VIEW_BILL');

    // Check-out keeps only the post-stay scopes for the window; sessions survive for those scopes.
    const left = new Date(Date.now() - 60_000);
    await fias(`GO|RN505|G#R7-${stamp}|DA${fiasDate(left)}|TI${fiasTime(left)}|`);
    await drain();
    expect((await api.authenticateGuestSession(phone.token))!.scopes).toEqual([
      'LOST_FOUND',
      'FEEDBACK',
      'INVOICE',
      'SUPPORT',
    ]);
    expect((await api.authenticateGuestSession(companionSession.token))!.scopes).toEqual([
      'LOST_FOUND',
      'FEEDBACK',
      'SUPPORT',
    ]);
    // Verifying again after check-out returns the live post-stay grant; it never widens back.
    const again = await issue(primary);
    expect(again).toMatchObject({
      id: pre.id,
      effectiveScopes: ['LOST_FOUND', 'FEEDBACK', 'INVOICE', 'SUPPORT'],
    });
    const changed = await guestEvents('guest.grant.changed');
    expect(changed.map((e) => at(e.envelope, 'payload.change'))).toEqual(
      expect.arrayContaining(['WIDENED', 'NARROWED']),
    );

    // Staff see the grants with their history and end one; every session on it ends at once.
    const list = await http()
      .get(`${base()}/stays/${stay.id}/grants`)
      .set('X-Test-Actor', gm())
      .expect(200);
    const listed = (list.body as Array<{ id: string; history: Array<{ kind: string }> }>).find(
      (g) => g.id === pre.id,
    )!;
    expect(listed.history.map((h) => h.kind)).toEqual(['GRANTED', 'WIDENED', 'NARROWED']);
    await http()
      .post(`${base()}/guest-grants/${pre.id}/revoke`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'Guest asked to sign out every device' })
      .expect(200);
    expect(await api.authenticateGuestSession(phone.token)).toBeNull();
    expect(await api.authenticateGuestSession(tablet.token)).toBeNull();
    await http()
      .post(`${base()}/guest-grants/${pre.id}/revoke`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'Guest asked to sign out every device' })
      .expect(409);
    const revoked = await guestEvents('guest.grant.revoked');
    expect(at(revoked.at(-1)!.envelope, 'payload')).toMatchObject({
      reason: 'STAFF',
      sessions_revoked: 2,
    });
    // History is append-only; another tenant never sees the grants.
    expect(
      await dbError(() =>
        db.execute(
          sql`update guest.guest_access_grant_events set reason = 'X' where grant_id = ${pre.id}`,
        ),
      ),
    ).toMatch(/append-only/);
    await http()
      .get(`${base()}/stays/${stay.id}/grants`)
      .set('X-Test-Actor', user('other', tenantB))
      .expect(404);
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
